import {
  DESC,
  sanitizeOutput,
  truncate,
  makeDecoder,
  BASH_TIMEOUT_MS,
  IGNORED_DIRS,
  resolveInCwd,
  shellSegments,
  isDestructiveGitSegment,
  insideGitRepo,
  globToRegex
} from "./shared.mjs";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export const bashTool = {
  name: "bash",
  description: DESC("bash"),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: `Timeout in ms (default ${BASH_TIMEOUT_MS})` },
    },
    required: ["command"],
  },
  readonly: false,
  async execute(args, ctx) {
    // 安全预检：销毁性 git 操作先检查未提交改动，有则拒绝——防一键清掉几小时工作
    if (shellSegments(args.command).some(isDestructiveGitSegment)) {
      if (!insideGitRepo(ctx.cwd)) {
        throw new Error(`Refusing destructive git command: not a git repository: ${ctx.cwd}`)
      }
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (status) {
        throw new Error(
          `Refusing destructive git command: uncommitted changes exist. Commit or stash first.\n` +
          `(If uncommitted work was already lost, the checkpoint tool can restore the auto-snapshot: action=list, then action=rewind.)\n\n${status}`
        )
      }
    }

    return new Promise((resolve) => {
      // detached: 让子进程成为进程组组长，超时/中断时才能整树杀掉（POSIX 用负 pid 组杀，
      // Windows 用 taskkill /T）——只 kill 壳进程会把孙进程（如 npm test）留在后台继续跑
      const killTree = () => {
        if (process.platform === "win32") {
          try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
        } else {
          try { process.kill(-child.pid, "SIGKILL") } catch {}
          try { child.kill("SIGKILL") } catch {} // 组杀失败时兜底杀本体
        }
      }
      // Windows 中文系统默认代码页是 GBK (CP936)，cmd.exe 重定向写文件时用 ANSI 代码页，
      // chcp 65001 也改不了重定向的编码。bash 工具写含 CJK 的文件会产生 GBK——
      // 提示词层已禁止用 bash 写文件（用 write/edit 工具替代），这里设 PYTHONIOENCODING
      // 覆盖 Python 脚本的 stdout 编码（Python 是唯一可能正确响应环境变量的子进程）
      const winCmd = process.platform === "win32"
      const child = spawn(args.command, {
        cwd: ctx.cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          EDITOR: "true",
          VISUAL: "true",
          GIT_PAGER: "cat",
          PAGER: "cat",
          TERM: "dumb",
          ...(winCmd ? { PYTHONIOENCODING: "utf-8" } : {}),
        },
      })
      // stdout / stderr 各自独立解码（同进程通常同编码，但分开收集更干净，
      // 且允许模型按 stderr 快速定位错误）
      const outDecoder = makeDecoder()
      const errDecoder = makeDecoder()
      let outBuf = ""
      let errBuf = ""
      let truncatedNote = ""

      const onStdout = (d) => {
        const s = sanitizeOutput(outDecoder(d))
        if (s) {
          ctx.onOutput?.(s)
          if (outBuf.length < 2_000_000) outBuf += s
          else if (!truncatedNote) truncatedNote = "\n[... output exceeded 2MB, remainder discarded]"
        }
      }
      const onStderr = (d) => {
        const s = sanitizeOutput(errDecoder(d)) // 始终解码，防 pending 无限累积
        if (errBuf.length < 2_000_000) errBuf += s
      }

      child.stdout.on("data", onStdout)
      child.stderr.on("data", onStderr)

      const timer = setTimeout(killTree, args.timeout ?? BASH_TIMEOUT_MS)
      if (ctx.signal) {
        ctx.signal.addEventListener("abort", killTree, { once: true })
      }
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve(truncate(`Command failed: ${error.message}\n[stdout]:\n${outBuf || "(empty)"}`))
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        // 冲刷解码器尾部
        outBuf += sanitizeOutput(outDecoder(Buffer.alloc(0), true))
        errBuf += sanitizeOutput(errDecoder(Buffer.alloc(0), true))
        const status = signal
          ? `killed: ${ctx.signal?.aborted ? "user interrupted" : "timeout"}`
          : `exit code ${code}`
        const parts = [`[stdout]:\n${outBuf.trim() || "(empty)"}`]
        if (errBuf.trim()) parts.push(`[stderr]:\n${errBuf.trim()}`)
        parts.push(`(${status})`)
        resolve(truncate(parts.join("\n\n") + truncatedNote))
      })
    })
  },
}

// ---------------------------------------------------------------- glob

export const globTool = {
  name: "glob",
  description: DESC("glob"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search in (default cwd)" },
    },
    required: ["pattern"],
  },
  readonly: true,
  async execute(args, ctx) {
    const base = resolveInCwd(ctx, args.path ?? ".")
    const regex = globToRegex(args.pattern)
    const results = []
    for await (const relPath of walkFiles(base)) {
      if (regex.test(relPath)) {
        results.push(relPath)
        if (results.length >= 1000) break
      }
    }
    if (results.length === 0) return "(no matches)"
    return truncate(results.sort().join("\n"))
  },
}

/** 递归遍历文件，产出相对路径（跳过 IGNORED_DIRS） */
async function* walkFiles(dir, rel = "") {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      yield* walkFiles(join(dir, e.name), relPath)
    } else {
      yield relPath
    }
  }
}

/** glob 转正则：**\/ 匹配零或多级目录，** 跨目录，* 段内，? 段内单字符 */

// ---------------------------------------------------------------- grep

export const grepTool = {
  name: "grep",
  description: DESC("grep"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory or file to search (default cwd)" },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.mjs')" },
      before: { type: "integer", description: "Lines of context to show before each match (grep -B). Default 0" },
      after: { type: "integer", description: "Lines of context to show after each match (grep -A). Default 0" },
    },
    required: ["pattern"],
  },
  readonly: true,
  async execute(args, ctx) {
    const base = resolveInCwd(ctx, args.path ?? ".")
    const regex = new RegExp(args.pattern)
    const fileFilter = args.glob ? globToRegex(args.glob) : null
    const before = Math.max(0, Math.floor(args.before ?? 0))
    const after = Math.max(0, Math.floor(args.after ?? 0))
    const wantCtx = before > 0 || after > 0
    const hits = [] // { file, line(1-based), text }
    const fileLines = new Map() // file -> string[]（仅 wantCtx 时缓存）

    async function search(file) {
      let content
      try {
        content = await readFile(file, "utf8")
      } catch {
        return // 不可读文件跳过；二进制会被按 utf8 读入并照常搜索（可能产生乱码匹配）
      }
      const lines = content.split("\n")
      if (wantCtx) fileLines.set(file, lines)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push({ file, line: i + 1, text: lines[i] })
          if (hits.length >= 200) return
        }
      }
    }

    async function walk(target) {
      if (hits.length >= 200) return
      const s = await stat(target)
      if (!s.isDirectory()) {
        if (!fileFilter || fileFilter.test(target.split(/[\\/]/).pop())) await search(target)
        return
      }
      let entries
      try {
        entries = await readdir(target, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
        await walk(join(target, e.name))
      }
    }

    await walk(base)
    if (hits.length === 0) return "(no matches)"

    // 无上下文：保持原 path:line: content 格式
    if (!wantCtx) {
      return truncate(hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n"))
    }

    // 带上下文：匹配行用 ':'，上下文行用 '-'（同 ripgrep）；同文件相邻区间去重合并
    const fileMatched = new Map() // file -> Set<line>
    for (const h of hits) {
      if (!fileMatched.has(h.file)) fileMatched.set(h.file, new Set())
      fileMatched.get(h.file).add(h.line)
    }
    const out = []
    for (const [file, matchedLines] of fileMatched) {
      const lines = fileLines.get(file) ?? []
      const lineSet = new Set()
      for (const ml of matchedLines) {
        for (let l = Math.max(1, ml - before); l <= Math.min(lines.length, ml + after); l++) lineSet.add(l)
      }
      for (const l of [...lineSet].sort((a, b) => a - b)) {
        const sep = matchedLines.has(l) ? ":" : "-"
        out.push(`${file}${sep}${l}${sep} ${lines[l - 1]}`)
      }
    }
    return truncate(out.join("\n"))
  },
}

// ---------------------------------------------------------------- websearch

export const lsTool = {
  name: "ls",
  description: DESC("ls"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default cwd)" },
    },
  },
  readonly: true,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path ?? ".")
    const entries = await readdir(abs, { withFileTypes: true })
    const rows = await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        const s = await stat(join(abs, e.name)).catch(() => null)
        const isDir = e.isDirectory()
        return {
          dir: isDir,
          name: e.name + (isDir ? "/" : ""),
          size: s?.size ?? 0,
          mtime: s ? s.mtime.toISOString().slice(0, 16).replace("T", " ") : "?",
        }
      }),
    )
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    if (rows.length === 0) return "(empty directory)"
    const out = rows.map((r) => `${r.dir ? "d" : "-"}  ${r.name.padEnd(40)} ${String(r.size).padStart(10)}  ${r.mtime}`)
    return truncate(out.join("\n"))
  },
}

// ---------------------------------------------------------------- fetch
