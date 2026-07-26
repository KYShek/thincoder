/**
 * tools.mjs — 内置工具集
 * read / write / edit / insert_after / apply_patch / bash / glob / grep / websearch / ls / fetch / delete / git_diff / git_status / git_log / question / checkpoint，零依赖实现。
 * 工具描述从 src/tools/*.md 加载（方便人读和修改）。
 * readonly 标记供 agent 调度：只读工具可并行，有副作用工具串行。
 */

import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, stat, writeFile, unlink } from "node:fs/promises"
import { readFileSync, existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESC = (name) => readFileSync(join(__dirname, "tools", `${name}.md`), "utf8")

const MAX_READ_LINES = 2000
// 输出上限只是内存安全阀：超过 16k 的输出由 agent 层 offload 整体落盘（全量保留、预览+路径回喂），
// 这里截断必须远高于落盘阈值，否则被截掉的内容在落盘前就永远丢了
const MAX_OUTPUT_CHARS = 200_000
const BASH_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BODY_BYTES = 5_000_000
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage"])

/** 每个工具：{ name, description, parameters, readonly, execute(args, ctx) }（定义见文件末尾导出） */

/** 转成 OpenAI tools 参数格式 */
export function toOpenAISchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** 剥离 ANSI 转义序列（vim/less/颜色码会冲花 TUI 渲染），并把 \r 进度条改写转成换行 */
function sanitizeOutput(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[\x40-\x7E]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n[... truncated: ${text.length - max} chars omitted — redirect to a file if you need the full output]`
}

/** 限量读取响应体：超 limit 字节即取消流，防超大页面把整个 body 缓冲进内存 */
async function readBodyText(response, limit = MAX_RESPONSE_BODY_BYTES) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
      if (total >= limit) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks))
}

/** 创建独立的流解码器（编码嗅探：ASCII → UTF-8 → GBK 回退） */
function makeDecoder() {
  let decoder = null
  let pending = Buffer.alloc(0)
  return (d, flush = false) => {
    pending = Buffer.concat([pending, d])
    if (!decoder) {
      const hasHighByte = pending.some((b) => b >= 0x80)
      if (!hasHighByte) {
        const s = pending.toString("ascii")
        pending = Buffer.alloc(0)
        return s
      }
      for (let trim = 0; trim <= 3 && !decoder; trim++) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, pending.length - trim))
          decoder = new TextDecoder("utf-8")
        } catch { /* 继续尝试 */ }
      }
      if (!decoder) decoder = new TextDecoder("gbk")
    }
    const s = decoder.decode(pending, { stream: !flush })
    pending = Buffer.alloc(0)
    return s
  }
}

/** 对单个文件取 git diff，失败静默返回空 */
function gitDiffOne(cwd, abs) {
  try {
    const diff = execFileSync("git", ["--no-pager", "diff", "--no-color", "--", abs], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024,
    }).trim()
    if (!diff) return ""
    // 截断超长 diff（超大文件改动 diff 可能几十 KB），只保留前 200 行
    const lines = diff.split("\n")
    if (lines.length <= 200) return diff
    return lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more diff lines)`
  } catch {
    return ""
  }
}

/** 目标可能不存在（write 新文件），逐级向上找真实存在的祖先做 realpath */
function realpathNearest(abs) {
  let cur = abs
  const tail = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs // 到根了，原样返回（不会发生）
    tail.unshift(cur.slice(parent.length + 1))
    cur = parent
  }
  try {
    const real = realpathSync(cur)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return abs
  }
}

// cwd 的 realpath 缓存：进程内 cwd 不变，只需解析一次
const realCwdCache = new Map()
function realCwd(cwd) {
  if (!realCwdCache.has(cwd)) realCwdCache.set(cwd, realpathNearest(resolve(cwd)))
  return realCwdCache.get(cwd)
}

function assertInside(cwd, resolved, p) {
  const rel = relative(cwd, resolved)
  // 跨盘符时 relative 返回绝对路径（Windows）；startsWith("..") 会误伤 cwd 内的 "..foo"，故精确判断
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(`Access denied outside working directory: ${p}`)
  }
}

function resolveInCwd(ctx, p) {
  const cwd = realCwd(ctx.cwd)
  const resolved = resolve(cwd, p)
  assertInside(cwd, resolved, p)
  // 防 symlink 逃逸：cwd 内若存在指向外部的符号链接，realpath 后会落到 cwd 外
  const real = realpathNearest(resolved)
  assertInside(cwd, real, p)
  return resolved
}

/**
 * 破坏性预检用的粗切分：&& || ; | 换行 命令替换 子 shell 都视作命令边界。
 * 宁多切不少切——防 "cd x && git checkout ."、"echo $(git checkout .)" 这类写法绕过行首锚定
 */
function shellSegments(command) {
  return command.split(/&&|\|\||[;|\n]|\$\(|`|[(]/)
}

/**
 * 单个命令段是否会销毁未提交改动：
 * checkout -- / checkout . / reset --hard / clean -f* / restore（动工作区的）
 * checkout <branch>、restore --staged、clean -n（dry-run）不算
 */
function isDestructiveGitSegment(seg) {
  if (!/^\s*git\s/.test(seg)) return false
  if (/\scheckout\s+(?:--|\.(?:\s|$))/.test(seg)) return true
  if (/\sreset\s+--hard\b/.test(seg)) return true
  if (/\sclean\s+-\S*f/.test(seg)) return true
  if (/\srestore\s/.test(seg) && (/--worktree/.test(seg) || !/--staged/.test(seg))) return true
  return false
}

/** cwd 是否在 git 仓库内（预检用，失败静默视为不在） */
function insideGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- read

const readTool = {
  name: "read",
  description: DESC("read"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to cwd or absolute)" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: `Max lines to return (default ${MAX_READ_LINES})` },
    },
    required: ["path"],
  },
  readonly: true,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    // 注意：整文件一次性读入内存，大文件会被完整缓冲（offset/limit 只影响返回切片）
    const content = await readFile(abs, "utf8")
    const lines = content.split("\n")
    const offset = Math.max(1, args.offset ?? 1)
    const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n")
    const suffix = offset - 1 + limit < lines.length ? `\n... (${lines.length} lines total, use offset to continue)` : ""
    return truncate(numbered + suffix)
  },
}

// ---------------------------------------------------------------- write

const writeTool = {
  name: "write",
  description: DESC("write"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to cwd or absolute)" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    await mkdir(dirname(abs), { recursive: true })
    const st = await stat(abs).catch(() => null)
    if (st?.isDirectory()) throw new Error(`Path is a directory: ${abs}`)
    await writeFile(abs, args.content, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Wrote ${args.content.length} chars to ${abs}${diff ? "\n" + diff : ""}`
  },
}

// ---------------------------------------------------------------- edit

const editTool = {
  name: "edit",
  description: DESC("edit"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    if (!args.old_string) {
      throw new Error("old_string must not be empty (empty string matches everywhere and would corrupt the file)")
    }
    const content = await readFile(abs, "utf8")
    const occurrences = content.split(args.old_string).length - 1
    if (occurrences === 0) {
      // 给出线索帮模型定位：首行预览 + 常见原因
      const preview = args.old_string.slice(0, 100).split("\n")[0]
      throw new Error(
        `old_string not found in ${abs}\n` +
        `  searched: "${preview}${args.old_string.length > 100 ? "…" : ""}"\n` +
        `  hints: whitespace mismatch? file already changed? try reading the file first`
      )
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(`old_string matches ${occurrences} times in ${abs}; provide more context or set replace_all`)
    }
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      // 函数式替换：避免 new_string 里的 $ 替换模式（匹配串/前后文引用）被展开
      : content.replace(args.old_string, () => args.new_string)
    await writeFile(abs, updated, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Edited ${abs}: replaced ${args.replace_all ? occurrences : 1} occurrence(s)${diff ? "\n" + diff : ""}`
  },
}

// ---------------------------------------------------------------- insert_after

const insertAfterTool = {
  name: "insert_after",
  description: DESC("insert_after"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      after_line: { type: "number", description: "Line number to insert after (1-based). Takes priority over after_regex." },
      after_regex: { type: "string", description: "JavaScript regex to find the line to insert after (must match exactly one line)" },
      content: { type: "string", description: "Text to insert (with leading newline if you need a blank line)" },
    },
    required: ["path", "content"],
  },
  readonly: false,
  async execute(args, ctx) {
    const abs = resolveInCwd(ctx, args.path)
    const text = await readFile(abs, "utf8")
    const lines = text.split("\n")

    let targetLine
    if (args.after_line != null) {
      targetLine = args.after_line
      if (!Number.isInteger(targetLine)) {
        throw new Error(`after_line must be an integer, got: ${args.after_line}`)
      }
      if (targetLine < 1 || targetLine > lines.length) {
        throw new Error(`after_line ${targetLine} out of range (file has ${lines.length} lines)`)
      }
    } else if (args.after_regex) {
      const regex = new RegExp(args.after_regex)
      const matches = []
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) matches.push(i + 1)
      }
      if (matches.length === 0) throw new Error(`after_regex /${args.after_regex}/ matched no lines in ${abs}`)
      if (matches.length > 1) throw new Error(`after_regex /${args.after_regex}/ matched ${matches.length} lines (${matches.slice(0, 5).join(", ")}${matches.length > 5 ? "…" : ""}); use a more specific pattern or after_line instead`)
      targetLine = matches[0]
    } else {
      throw new Error("Either after_line or after_regex is required")
    }

    lines.splice(targetLine, 0, args.content)
    const updated = lines.join("\n")
    await writeFile(abs, updated, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Inserted after line ${targetLine} in ${abs}${diff ? "\n" + diff : ""}`
  },
}

// ---------------------------------------------------------------- apply_patch

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

const applyPatchTool = {
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
    for (const p of planned) {
      await mkdir(dirname(p.abs), { recursive: true })
      await writeFile(p.abs, p.content, "utf8")
    }
    const summary = planned.map((p) => `  ${p.isNew ? "created " : "modified"} ${p.path}`).join("\n")
    return `Applied patch to ${planned.length} file(s):\n${summary}`
  },
}

// ---------------------------------------------------------------- syntax_check

const syntaxCheckTool = {
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
      return `syntax_check only supports .js/.mjs/.cjs files; ${abs} skipped.`
    }
    try {
      execFileSync(process.execPath, ["--check", abs], {
        cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      })
      return `Syntax OK: ${abs}`
    } catch (e) {
      // node --check 把错误写到 stderr
      const msg = (e.stderr || e.stdout || e.message || "").trim()
      return `Syntax error in ${abs}:\n${msg || "(unknown)"}`
    }
  },
}

// ---------------------------------------------------------------- bash

const bashTool = {
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

const globTool = {
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
function globToRegex(pattern) {
  const DS = "\u0001" // **/ 的占位符（零或多级目录）
  const DP = "\u0002" // ** 的占位符
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&") // [ ] 不转义，保留为 glob 字符组语法
    .replace(/\*\*\//g, DS)
    .replace(/\*\*/g, DP)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(DS, "(?:.*/)?")
    .replaceAll(DP, ".*")
  return new RegExp("^" + escaped + "$")
}

// ---------------------------------------------------------------- grep

const grepTool = {
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

const websearchTool = {
  name: "websearch",
  description: DESC("websearch"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  readonly: true,
  async execute(args, ctx) {
    const limit = args.limit ?? 8
    const url = `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`
    let html
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      html = await readBodyText(response)
    } catch (error) {
      throw new Error(`websearch request failed: ${error.cause?.code ?? error.message}`)
    }

    // 结果块 <li class="b_algo">：<h2><a href>标题</a></h2> + <p>摘要</p>
    const blocks = html.split('<li class="b_algo"').slice(1)
    const results = []
    for (const block of blocks) {
      const link = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!link) continue
      const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      results.push({
        href: link[1],
        title: stripTags(link[2]),
        snippet: snippet ? stripTags(snippet[1]) : "",
      })
      if (results.length >= limit) break
    }
    if (results.length === 0) return "(no results)"
    return truncate(
      results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}\n   ${r.snippet}`).join("\n\n"),
    )
  },
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&ensp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&") // &amp; 必须最后解码，否则 &amp;lt; 会被二次解码成 <
    .replace(/\s+/g, " ")
    .trim()
}

// ---------------------------------------------------------------- ls

const lsTool = {
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

const fetchTool = {
  name: "fetch",
  description: DESC("fetch"),
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http/https URL" },
    },
    required: ["url"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://")
    let response
    try {
      response = await fetch(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new Error(`fetch failed: ${error.cause?.code ?? error.message}`)
    }
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`)

    const contentType = response.headers.get("content-type") ?? ""
    const body = await readBodyText(response)
    if (!contentType.includes("text/html")) return truncate(body)
    return truncate(htmlToText(body))
  },
}

/** HTML → 粗文本：去脚本样式、块级标签换行、剥标签、解码实体、压缩空行 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;|&ensp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&") // &amp; 必须最后解码，否则 &amp;lt; 会被二次解码成 <
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

export const builtinTools = [readTool, writeTool, editTool, insertAfterTool, applyPatchTool, syntaxCheckTool, bashTool, globTool, grepTool, websearchTool, lsTool, fetchTool]

// ---------------------------------------------------------------- delete

const deleteTool = {
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
    if (!existsSync(abs)) throw new Error(`File not found: ${abs}`)
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
    return `Deleted ${abs}`
  },
}

// ---------------------------------------------------------------- git_diff

const gitDiffTool = {
  name: "git_diff",
  description: DESC("git_diff"),
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes (default false)" },
      path: { type: "string", description: "File or directory to diff (default all)" },
      ref: { type: "string", description: "Compare against this ref (default HEAD)" },
    },
  },
  readonly: true,
  execute(args, ctx) {
    const ref = args.ref ?? "HEAD"
    // ref 由模型提供且位于 "--" 之前：校验字符集，防 "--output=..." 之类被 git 当成选项
    if (!/^[A-Za-z0-9._\/~^][A-Za-z0-9._\/~^-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
    const flags = args.staged ? ["--staged"] : []
    const paths = args.path ? [args.path] : []
    const out = runGit(ctx.cwd, ["diff", ...flags, ref, "--", ...paths])
    return truncate(out || "(no changes)")
  },
}

// ---------------------------------------------------------------- git_status

const gitStatusTool = {
  name: "git_status",
  description: DESC("git_status"),
  parameters: {
    type: "object",
    properties: {},
  },
  readonly: true,
  execute(_args, ctx) {
    const porcelain = runGit(ctx.cwd, ["status", "--porcelain"])
    if (!porcelain) return "(clean — no changes)"

    const staged = []
    const unstaged = []
    const untracked = []
    const conflicts = []
    for (const line of porcelain.split("\n")) {
      if (!line) continue
      // porcelain: XY path — 2 状态字符 + 空格 + 文件路径（部分环境只 1 空格）
      // 去掉可能的 CR（execFileSync 在某些 Windows git 下会残留 \r 在行末但不在换行符中）
      const clean = line.replace(/\r/g, "")
      // 尝试匹配 "XY path" 或 "XY  path"（可变间距）
      const m = clean.match(/^(..?)\s+(.+)$/)
      if (!m) continue
      const [, status, rawFile] = m
      // 重命名条目 porcelain 输出为 "R  old -> new"，拆开明确展示而非当成一个字面文件名
      const file = status.includes("R") && rawFile.includes(" -> ") ? rawFile.replace(" -> ", " → ") : rawFile
      const idx = status[0] ?? " "
      const wt = status[1] ?? " "
      if (idx === "U" || wt === "U" || (idx === "A" && wt === "A")) {
        conflicts.push(file)
      } else if (idx === "?" && wt === "?") {
        untracked.push(file)
      } else {
        if (idx !== " " && idx !== "?") staged.push(idx + " " + file)
        if (wt !== " " && wt !== "?") unstaged.push(wt + " " + file)
      }
    }
    const parts = []
    if (staged.length) parts.push("Staged (" + staged.length + "):\n" + staged.join("\n"))
    if (unstaged.length) parts.push("Unstaged (" + unstaged.length + "):\n" + unstaged.join("\n"))
    if (untracked.length) parts.push("Untracked (" + untracked.length + "):\n" + untracked.join("\n"))
    if (conflicts.length) parts.push("Conflicts (" + conflicts.length + "):\n" + conflicts.join("\n"))
    return truncate(parts.join("\n\n"))
  },
}

// ---------------------------------------------------------------- git_log

const gitLogTool = {
  name: "git_log",
  description: DESC("git_log"),
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 10)" },
      path: { type: "string", description: "File or directory (default all)" },
      oneline: { type: "boolean", description: "One-line-per-commit format (default false)" },
    },
  },
  readonly: true,
  execute(args, ctx) {
    const n = args.count ?? 10
    const isOneline = args.oneline
    const cmdArgs = isOneline
      ? ["log", "-" + n, "--oneline"]
      : ["log", "-" + n, "--format=%h %ad %an %s", "--date=short"]
    if (args.path) cmdArgs.push("--", args.path)
    const out = runGit(ctx.cwd, cmdArgs)
    return truncate(out || "(no commits)")
  },
}

// ---------------------------------------------------------------- question

const questionTool = {
  name: "question",
  description: DESC("question"),
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Single-choice options for the user to pick from (optional)",
      },
    },
    required: ["question"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (!ctx.onQuestion) throw new Error("question tool not supported in this context (no UI to ask)")
    return ctx.onQuestion(args.question, args.options ?? [])
  },
}

/** 执行 git 命令；非 git 仓库 / git 不可用时返回空字符串 */
function runGit(cwd, cmdArgs) {
  try {
    return execFileSync("git", cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\r/g, "")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------- checkpoint

const checkpointTool = {
  name: "checkpoint",
  description: DESC("checkpoint"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create", "rewind"], description: "list snapshots / create one now / restore a snapshot by id" },
      id: { type: "string", description: "Snapshot id (required for rewind)" },
    },
    required: ["action"],
  },
  readonly: false,
  async execute(args, ctx) {
    const { createCheckpoint, listCheckpoints, rewind, isGitRepo } = await import("./checkpoint.mjs")
    if (!isGitRepo(ctx.cwd)) throw new Error("Not a git repository — checkpoints unavailable")
    if (args.action === "create") {
      const cp = await createCheckpoint(ctx.cwd)
      return `Checkpoint ${cp.id} created (${cp.files} file(s) captured)`
    }
    if (args.action === "rewind") {
      if (!args.id) throw new Error("id is required for rewind — use action=list to see snapshot ids")
      const s = await rewind(ctx.cwd, args.id)
      return `Rewound to checkpoint ${args.id}: patch ${s.patchApplied ? "applied" : "(empty)"}, ${s.restored} untracked file(s) restored, ${s.deleted} file(s) deleted.\n(The pre-rewind state was snapshotted first — you can rewind again to go back.)`
    }
    if (args.action === "list") {
      const cps = await listCheckpoints(ctx.cwd)
      if (cps.length === 0) return "(no checkpoints yet — one is auto-created before each user task)"
      return cps.map((c) => `${c.id}  ${new Date(c.time).toISOString()}  ${c.untracked} untracked file(s)`).join("\n")
    }
    throw new Error(`Unknown action: ${args.action}`)
  },
}

export { deleteTool, gitDiffTool, gitStatusTool, gitLogTool, questionTool, checkpointTool }
builtinTools.push(deleteTool, gitDiffTool, gitStatusTool, gitLogTool, questionTool, checkpointTool)
