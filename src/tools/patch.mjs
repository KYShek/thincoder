import {
  DESC,
  autoSyntaxCheck,
  resolveInCwd
} from "./shared.mjs";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

/**
 * 解析统一 diff（unified diff）：返回 [{ path, isNew, hunks: [{ ops: [{type:" "|"-"|"+", text}] }] }]
 * 按 @@ 头的行数计数消费 hunk 行——LLM 常把上下文空行剥成纯空行，靠计数而不是行首字符判断 hunk 边界
 */
function parsePatch(patch) {
  // 补丁文本常来自 CRLF 终端/模型输出，行尾 \r 会混进 hunk 内容导致上下文对不上，统一剥掉
  const lines = patch.replace(/\r(?=\n|$)/g, "").split("\n")
  const files = []
  let cur = null
  let i = 0
  const stripPrefix = (p) => p.replace(/^[ab]\//, "")
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim()
      const plus = lines[i + 1]
      if (!plus?.startsWith("+++ ")) throw new Error(`Malformed patch: expected "+++" line after "${line}"`)
      const newPath = plus.slice(4).trim()
      if (newPath === "/dev/null") throw new Error("Deleting files via patch is not supported — use the delete tool")
      cur = { path: stripPrefix(newPath), isNew: oldPath === "/dev/null", hunks: [] }
      files.push(cur)
      i += 2
      continue
    }
    if (line.startsWith("@@")) {
      if (!cur) throw new Error("Malformed patch: hunk header before any file header")
      const m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/)
      if (!m) throw new Error(`Malformed patch: bad hunk header "${line}" (need @@ -old,count +new,count @@)`)
      let oldNeed = m[1] == null ? 1 : Number(m[1])
      let newNeed = m[2] == null ? 1 : Number(m[2])
      const hunk = { ops: [] }
      i++
      while (oldNeed > 0 || newNeed > 0) {
        if (i >= lines.length) throw new Error("Malformed patch: hunk truncated (line counts in @@ header not satisfied)")
        const hl = lines[i]
        if (hl.startsWith("\\")) { i++; continue } // "\ No newline at end of file"
        const tag = hl === "" ? " " : hl[0] // 纯空行按上下文行宽容处理
        const text = hl === "" ? "" : hl.slice(1)
        if (tag === " ") { hunk.ops.push({ type: " ", text }); oldNeed--; newNeed-- }
        else if (tag === "-") { hunk.ops.push({ type: "-", text }); oldNeed-- }
        else if (tag === "+") { hunk.ops.push({ type: "+", text }); newNeed-- }
        else throw new Error(`Malformed patch: unexpected line "${hl.slice(0, 60)}" inside hunk`)
        i++
      }
      cur.hunks.push(hunk)
      continue
    }
    i++ // diff --git / index / 空行等元信息跳过
  }
  if (files.length === 0) throw new Error("No file changes found in patch (need --- / +++ headers)")
  return files
}

/** 在内存行数组上按序应用 hunks；任何一步失败抛错（调用方保证不落盘）。比较时忽略行尾 \r，上下文行保留原始字节 */
function applyHunks(fileLines, hunks, eol, path) {
  const cr = eol === "\r\n" ? "\r" : ""
  for (let h = 0; h < hunks.length; h++) {
    const oldSeq = hunks[h].ops.filter((o) => o.type !== "+").map((o) => o.text)
    if (oldSeq.length === 0) throw new Error(`Hunk ${h + 1} in ${path} has no context/removed lines to locate`)
    const matches = []
    for (let pos = 0; pos + oldSeq.length <= fileLines.length; pos++) {
      let ok = true
      for (let j = 0; j < oldSeq.length; j++) {
        if (fileLines[pos + j].replace(/\r$/, "") !== oldSeq[j]) { ok = false; break }
      }
      if (ok) matches.push(pos)
    }
    if (matches.length === 0) {
      const preview = oldSeq.slice(0, 3).join(" ⏎ ")
      throw new Error(`Hunk ${h + 1} in ${path} does not apply — context not found: "${preview}${oldSeq.length > 3 ? "…" : ""}". Read the file first and regenerate the patch from actual content.`)
    }
    if (matches.length > 1) throw new Error(`Hunk ${h + 1} in ${path} matches ${matches.length} locations — add more context lines to make it unique`)
    const pos = matches[0]
    const out = []
    let src = pos
    for (const op of hunks[h].ops) {
      if (op.type === " ") out.push(fileLines[src++]) // 上下文保留原始行（行尾/空白原样）
      else if (op.type === "-") src++
      else out.push(op.text + cr)
    }
    fileLines.splice(pos, oldSeq.length, ...out)
  }
}

export const applyPatchTool = {
  name: "apply_patch",
  description: DESC("apply_patch"),
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Unified diff. May span multiple files; --- / +++ headers per file, @@ -old,count +new,count @@ hunks. Use --- /dev/null to create a file." },
    },
    required: ["patch"],
  },
  readonly: false,
  /** 供 agent 层追踪触碰文件（多路径，替代单 path 参数） */
  touchedPaths(args) {
    try { return parsePatch(args.patch ?? "").map((f) => f.path) } catch { return [] }
  },
  async execute(args, ctx) {
    const files = parsePatch(args.patch ?? "")
    // 先全部读入内存试算：任何一个 hunk 不上就整体抛错，不写半个补丁（原子性）
    const planned = []
    for (const f of files) {
      const abs = resolveInCwd(ctx, f.path)
      if (f.isNew) {
        if (existsSync(abs)) throw new Error(`Cannot create ${f.path}: file already exists`)
        const content = f.hunks.flatMap((h) => h.ops.filter((o) => o.type === "+").map((o) => o.text)).join("\n") + "\n"
        planned.push({ abs, path: f.path, content, isNew: true })
      } else {
        const original = await readFile(abs, "utf8").catch(() => { throw new Error(`File not found: ${f.path}`) })
        const eol = original.includes("\r\n") ? "\r\n" : "\n"
        const lines = original.split("\n")
        applyHunks(lines, f.hunks, eol, f.path)
        planned.push({ abs, path: f.path, content: lines.join("\n"), isNew: false })
      }
    }
    // 多文件原子写：先全部写 .tmp，全部成功后再 rename——任一写失败不影响已落盘的文件
    const { rename } = await import("node:fs/promises")
    for (const p of planned) {
      await mkdir(dirname(p.abs), { recursive: true })
      await writeFile(p.abs + ".thincoder-tmp", p.content, "utf8")
    }
    for (const p of planned) {
      await rename(p.abs + ".thincoder-tmp", p.abs)
    }
    const summary = planned.map((p) => `  ${p.isNew ? "created " : "modified"} ${p.path}`).join("\n")
    const syntaxResults = planned.map((p) => {
      const r = autoSyntaxCheck(p.abs)
      return r ? `${p.path}:${r.replace("Syntax: ", "")}` : ""
    }).filter(Boolean).join("\n")
    return `Applied patch to ${planned.length} file(s):\n${summary}${syntaxResults ? "\n\nSyntax checks:\n" + syntaxResults : ""}`
  },
}

// ---------------------------------------------------------------- syntax_check

export const syntaxCheckTool = {
  name: "syntax_check",
  description: DESC("syntax_check"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (.js/.mjs/.cjs only)" },
    },
    required: ["path"],
  },
  readonly: true,
  execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    if (!/\.(?:[mc]?js)$/.test(abs)) {
      return `syntax_check only supports .js/.mjs/.cjs files; ${args.path} skipped.`
    }
    try {
      execFileSync(process.execPath, ["--check", abs], {
        cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      })
      return `Syntax OK: ${args.path}`
    } catch (e) {
      // node --check 把错误写到 stderr
      const msg = (e.stderr || e.stdout || e.message || "").trim()
      return `Syntax error in ${args.path}:\n${msg || "(unknown)"}`
    }
  },
}

// ---------------------------------------------------------------- bash

export const deleteTool = {
  name: "delete",
  description: DESC("delete"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to cwd or absolute)" },
      force: { type: "boolean", description: "Allow deleting git-tracked files (default false)" },
    },
    required: ["path"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    if (!existsSync(abs)) throw new Error(`File not found: ${args.path}`)
    const s = await stat(abs)
    if (s.isDirectory()) throw new Error(`"${args.path}" is a directory — use bash to remove directories`)
    // git 跟踪文件拒绝直接删除（安全网）；未跟踪的放行
    // 用解析后的相对路径（统一正斜杠），防反斜杠/非常规路径绕过 ls-files 匹配
    const rel = relative(ctx.cwd, abs).replace(/\\/g, "/")
    let tracked = false
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: ctx.cwd, stdio: "ignore" })
      tracked = true
    } catch {
      // 未跟踪 / 非 git 仓库
    }
    if (tracked && !args.force) throw new Error(`"${args.path}" is git-tracked. Set force=true to delete anyway.`)
    await unlink(abs)
    return `Deleted ${args.path}`
  },
}

// ---------------------------------------------------------------- git_diff
