/**
 * tools.mjs — 内置工具集
 * read / write / edit / bash / glob / grep，零依赖实现。
 * readonly 标记供 agent 调度：只读工具可并行，有副作用工具串行。
 */

import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const MAX_READ_LINES = 2000
const MAX_OUTPUT_CHARS = 50_000
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
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... (truncated, ${text.length - max} chars omitted)`
}

function resolveInCwd(ctx, p) {
  return resolve(ctx.cwd, p)
}

// ---------------------------------------------------------------- read

const readTool = {
  name: "read",
  description:
    "Read a text file. Returns numbered lines. Use offset/limit to page large files.",
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
  description: "Write content to a file. Creates parent directories; overwrites existing file.",
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
    await writeFile(abs, args.content, "utf8")
    return `Wrote ${args.content.length} chars to ${abs}`
  },
}

// ---------------------------------------------------------------- edit

const editTool = {
  name: "edit",
  description:
    "Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.",
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
      throw new Error(`old_string not found in ${abs}`)
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(`old_string matches ${occurrences} times in ${abs}; provide more context or set replace_all`)
    }
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string)
    await writeFile(abs, updated, "utf8")
    return `Edited ${abs}: replaced ${args.replace_all ? occurrences : 1} occurrence(s)`
  },
}

// ---------------------------------------------------------------- bash

const bashTool = {
  name: "bash",
  description:
    "Execute a shell command and return stdout+stderr. Use for running commands, builds, tests.",
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
      child.on("error", (error) => {
        clearTimeout(timer)
        resolve(truncate(`Command failed: ${error.message}\n${out}`))
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        out += sanitizeOutput(feed(Buffer.alloc(0), true)) // 最终判定 + 冲刷解码器尾部
        const suffix = signal
          ? "\n(killed: timeout)"
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
  description: "Find files by glob pattern (e.g. 'src/**/*.mjs'). Returns matching paths.",
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
    const base = resolve(ctx.cwd, args.path ?? ".")
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
  description: "Search file contents with a regex. Returns matching lines as path:line: content.",
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
    const base = resolve(ctx.cwd, args.path ?? ".")
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
  description:
    "Search the web (Bing). Returns result titles, URLs, and snippets. Use for looking up current information, docs, error messages.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  readonly: true,
  async execute(args) {
    const limit = args.limit ?? 8
    const url = `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`
    let html
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(15_000),
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
  description:
    "List directory contents with type, size, and modification time. Directories listed first. Use to see what a directory contains (glob only matches files).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default cwd)" },
    },
  },
  readonly: true,
  async execute(args, ctx) {
    const abs = resolve(ctx.cwd, args.path ?? ".")
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
  description:
    "Fetch a URL and return its content as text (HTML pages are stripped to readable text). Use after websearch to read full documents.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http/https URL" },
    },
    required: ["url"],
  },
  readonly: true,
  async execute(args) {
    if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://")
    let response
    try {
      response = await fetch(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
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
