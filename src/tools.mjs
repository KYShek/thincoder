/**
 * tools.mjs — 内置工具集
 * read / write / edit / bash / glob / grep / websearch / ls / fetch / delete / git_diff / git_status / git_log / question，零依赖实现。
 * 工具描述从 src/tools/*.md 加载（方便人读和修改）。
 * readonly 标记供 agent 调度：只读工具可并行，有副作用工具串行。
 */

import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, stat, writeFile, unlink } from "node:fs/promises"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESC = (name) => readFileSync(join(__dirname, "tools", `${name}.md`), "utf8")

const MAX_READ_LINES = 2000
// 输出上限只是内存安全阀：超过 16k 的输出由 agent 层 offload 整体落盘（全量保留、预览+路径回喂），
// 这里截断必须远高于落盘阈值，否则被截掉的内容在落盘前就永远丢了
const MAX_OUTPUT_CHARS = 200_000
const BASH_TIMEOUT_MS = 120_000
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
  return text.slice(0, max) + `\n... (truncated, ${text.length - max} chars omitted)`
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

function resolveInCwd(ctx, p) {
  const resolved = resolve(ctx.cwd, p)
  if (relative(ctx.cwd, resolved).startsWith("..")) throw new Error(`Access denied outside working directory: ${p}`)
  return resolved
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
      : content.replace(args.old_string, args.new_string)
    await writeFile(abs, updated, "utf8")
    const diff = gitDiffOne(ctx.cwd, abs)
    return `Edited ${abs}: replaced ${args.replace_all ? occurrences : 1} occurrence(s)${diff ? "\n" + diff : ""}`
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
    // 安全预检：销毁性 git 操作（checkout -- / reset --hard）先检查未提交改动，
    // 有则拒绝——防一键清掉几小时工作（像今天 git checkout -- 六个文件那次）
    const DESTRUCTIVE_GIT = /^git\s+(?:checkout\s+--?\s+|reset\s+--hard\b)/
    if (DESTRUCTIVE_GIT.test(args.command)) {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (status) {
        throw new Error(
          `Refusing destructive git command: uncommitted changes exist. Commit or stash first.\n\n${status}`
        )
      }
    }

    return new Promise((resolve) => {
      const child = spawn(args.command, {
        cwd: ctx.cwd,
        shell: true,
        windowsHide: true,
        // 无 TTY 环境：stdin 置空（vim/less 这类交互程序立刻吃到 EOF 退出，而不是干等），
        // 并通过环境变量缴械编辑器/分页器/花哨输出
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
      // 编码嗅探：cmd 自带消息是 GBK，git/node 等程序是 UTF-8，平台判断不了。
      // 策略：纯 ASCII 段两种编码一致，直接透传不判定；遇到高位字节才用
      // fatal UTF-8 试解（容忍尾部 1~3 字节截断），失败则判 GBK；一经判定不再变更。
      // 已知边界：GBK 字节流极低概率恰好构成合法 UTF-8 序列，会误判为 UTF-8 产生乱码。
      // 更严谨的做法是 chcp 探测控制台代码页，但当前策略覆盖 99.9% 场景，不值得那份复杂度。
      let decoder = null
      let pending = Buffer.alloc(0)
      const feed = (d, flush = false) => {
        pending = Buffer.concat([pending, d])
        if (!decoder) {
          const hasHighByte = pending.some((b) => b >= 0x80)
          if (!hasHighByte) {
            // 纯 ASCII：UTF-8/GBK 完全一致，透传即可（无需判定）
            const s = pending.toString("ascii")
            pending = Buffer.alloc(0)
            return s
          }
          for (let trim = 0; trim <= 3 && !decoder; trim++) {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, pending.length - trim))
              decoder = new TextDecoder("utf-8")
            } catch {
              // 继续尝试
            }
          }
          if (!decoder) decoder = new TextDecoder("gbk")
        }
        const s = decoder.decode(pending, { stream: !flush })
        pending = Buffer.alloc(0)
        return s
      }

      let out = ""
      let truncatedNote = ""
      const onData = (d) => {
        const s = sanitizeOutput(feed(d))
        // 输出实时透传给 UI；本地缓冲超 2MB 后停止累积（防内存爆炸）
        if (s) ctx.onOutput?.(s)
        if (out.length < 2_000_000) {
          out += s
        } else if (!truncatedNote) {
          truncatedNote = "\n... (output exceeded 2MB, remainder discarded)"
        }
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)

      const timer = setTimeout(() => child.kill(), args.timeout ?? BASH_TIMEOUT_MS)
      // 用户中止：杀进程
      if (ctx.signal) {
        ctx.signal.addEventListener("abort", () => child.kill(), { once: true })
      }
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve(truncate(`Command failed: ${error.message}\n${out}`))
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        out += sanitizeOutput(feed(Buffer.alloc(0), true)) // 最终判定 + 冲刷解码器尾部
        const suffix = signal
          ? `\n(killed: ${ctx.signal?.aborted ? "user interrupted" : "timeout"})`
          : code !== 0
            ? `\n(exit code ${code})`
            : ""
        resolve(truncate((out.trim() || "(no output)") + suffix + truncatedNote))
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
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
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
    },
    required: ["pattern"],
  },
  readonly: true,
  async execute(args, ctx) {
    const base = resolveInCwd(ctx, args.path ?? ".")
    const regex = new RegExp(args.pattern)
    const fileFilter = args.glob ? globToRegex(args.glob) : null
    const matches = []

    async function search(file) {
      let content
      try {
        content = await readFile(file, "utf8")
      } catch {
        return // 二进制/不可读文件跳过
      }
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${file}:${i + 1}: ${lines[i]}`)
          if (matches.length >= 200) return
        }
      }
    }

    async function walk(target) {
      if (matches.length >= 200) return
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
    if (matches.length === 0) return "(no matches)"
    return truncate(matches.join("\n"))
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
      html = await response.text()
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
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
    const body = await response.text()
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

export const builtinTools = [readTool, writeTool, editTool, bashTool, globTool, grepTool, websearchTool, lsTool, fetchTool]

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
      const [, status, file] = m
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

export { deleteTool, gitDiffTool, gitStatusTool, gitLogTool, questionTool }
builtinTools.push(deleteTool, gitDiffTool, gitStatusTool, gitLogTool, questionTool)
