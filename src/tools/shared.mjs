/**
 * tools/shared.mjs — 共享工具函数、常量、OpenAI schema 转换
 * 被 tools/file.mjs / system.mjs / web.mjs / git.mjs 导入
 */

import { spawn, execFileSync } from "node:child_process"
import { readFileSync, existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DESC = (name) => readFileSync(join(__dirname, "..", "tools", `${name}.md`), "utf8")

export const MAX_READ_LINES = 2000
export const MAX_OUTPUT_CHARS = 200_000
export const BASH_TIMEOUT_MS = 120_000
export const MAX_RESPONSE_BODY_BYTES = 5_000_000
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage"])

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

/** 剥离 ANSI 转义序列 */
export function sanitizeOutput(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[\x40-\x7E]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

export function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n[... truncated: ${text.length - max} chars omitted — redirect to a file if you need the full output]`
}

/** 限量读取响应体 */
export async function readBodyText(response, limit = MAX_RESPONSE_BODY_BYTES) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) { chunks.push(value); total += value.length }
      if (total >= limit) { await reader.cancel(); break }
    }
  } finally { reader.releaseLock() }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks))
}

/** 流解码器：编码嗅探 ASCII→UTF-8→GBK。
 *  每调用一次创建独立解码实例——不可跨并行流共享（内部 decoder 状态积累）。 */
export function makeDecoder() {
  let decoder = null
  let pending = Buffer.alloc(0)
  return (d, flush = false) => {
    pending = Buffer.concat([pending, d])
    if (!decoder) {
      const hasHighByte = pending.some((b) => b >= 0x80)
      if (!hasHighByte) { const s = pending.toString("ascii"); pending = Buffer.alloc(0); return s }
      for (let trim = 0; trim <= 3 && !decoder; trim++) {
        try { new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, pending.length - trim)); decoder = new TextDecoder("utf-8") }
        catch { /* continue */ }
      }
      if (!decoder) decoder = new TextDecoder("gbk")
    }
    const s = decoder.decode(pending, { stream: !flush })
    pending = Buffer.alloc(0)
    return s
  }
}

/** 单文件 git diff，失败静默返回空。大 diff 超 maxBuffer 时截断而非吞掉 */
export function gitDiffOne(cwd, abs) {
  try {
    const diff = execFileSync("git", ["--no-pager", "diff", "--no-color", "--", abs], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 10 * 1024 * 1024,
    }).trim()
    if (!diff) return ""
    const lines = diff.split("\n")
    if (lines.length <= 200) return diff
    return lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more diff lines)`
  } catch (e) {
    // maxBuffer 溢出时 e.stdout 含已收集的部分；其他错误（非 git 仓库等）返回空
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && e.stdout) {
      const lines = e.stdout.toString().split("\n")
      return lines.slice(0, 200).join("\n") + `\n... (diff too large, showing first 200 of more lines)`
    }
    return ""
  }
}

/** 文件变更后自动语法检查 */
export function autoSyntaxCheck(abs) {
  if (!/\.(m?js)$/i.test(abs)) return ""
  try {
    execFileSync("node", ["--check", abs], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })
    return "\nSyntax: OK"
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || "").toString().split("\n").slice(0, 3).join("\n")
    return `\nSyntax: FAILED — ${err}\n(If this file was corrupted by a bad edit, recover it from a checkpoint: checkpoint action=list then action=rewind with the latest id.)`
  }
}

/** 逐级向上找真实路径 */
export function realpathNearest(abs) {
  let cur = abs
  const tail = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(cur.slice(parent.length + 1))
    cur = parent
  }
  try { const real = realpathSync(cur); return tail.length ? join(real, ...tail) : real }
  catch { return abs }
}

const realCwdCache = new Map()
export function realCwd(cwd) {
  if (!realCwdCache.has(cwd)) realCwdCache.set(cwd, realpathNearest(resolve(cwd)))
  return realCwdCache.get(cwd)
}

export function assertInside(cwd, resolved, p) {
  const rel = relative(cwd, resolved)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(`Access denied outside working directory: ${p}`)
  }
}

export function resolveInCwd(ctx, p) {
  const cwd = realCwd(ctx.cwd)
  const resolved = resolve(cwd, p)
  assertInside(cwd, resolved, p)
  const real = realpathNearest(resolved)
  assertInside(cwd, real, p)
  return resolved
}

/** 破坏性预检用的粗切分（也切 > >> <，使段内破坏性检测在重定向时仍生效） */
export function shellSegments(command) {
  return command.split(/&&|\|\||>>|\$\(|[;|\n<>]|`|[(]/)
}

/** 检测 shell 输出/输入重定向（> >> < 后跟文件名）——引号内未排除，保守拦截 */
export function hasFileRedirection(command) {
  return /(^|[\s;&|])>{1,2}\s*\S/.test(command) || /(^|[\s;&|])<\s*\S/.test(command)
}

/** 单命令段是否为破坏性非 git 命令（保守：宁可误拦） */
export function isDestructiveCommand(seg) {
  const s = seg
  // rm 同时带递归(-r/-R)与强制(-f)标志：-rf / -fr / -r -f / -Rf 等
  if (/\brm\b/.test(s) && /\s-\S*r/i.test(s) && /\s-\S*f/i.test(s)) return true
  if (/\brmdir\b/i.test(s)) return true
  if (/\bdel\b/i.test(s) && /\/f\b/i.test(s)) return true
  if (/\brd\b/i.test(s) && /\/s\b/i.test(s)) return true
  // format 作为命令调用（排除 --format= 之类的选项误报）
  if (/\bformat\b\s+\S/i.test(s) && !/--format\b/i.test(s)) return true
  if (/\bshred\b/i.test(s)) return true
  if (/\bdd\b/.test(s) && /\bof=/i.test(s)) return true
  if (/\bDROP\s+TABLE\b/i.test(s)) return true
  if (/\bDELETE\s+FROM\b/i.test(s)) return true
  if (/\bTRUNCATE\b/i.test(s)) return true
  return false
}

/** 单命令段是否销毁未提交改动 */
export function isDestructiveGitSegment(seg) {
  if (!/^\s*git\s/.test(seg)) return false
  if (/\scheckout\s+(?:--|\.(?:\s|$))/.test(seg)) return true
  if (/\sreset\s+--hard\b/.test(seg)) return true
  if (/\sclean\s+-\S*f/.test(seg)) return true
  if (/\srestore\s/.test(seg) && (/--worktree/.test(seg) || !/--staged/.test(seg))) return true
  return false
}

/** cwd 是否在 git 仓库内 */
export function insideGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })
    return true
  } catch { return false }
}

/** glob 转正则 */
export function globToRegex(pattern) {
  const DS = "\u0001", DP = "\u0002"
  const escaped = pattern
    .replace(/\*\*\//g, DS).replace(/\*\*/g, DP)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
    .replace(new RegExp(DS, "g"), "(?:.+/)?")
    .replace(new RegExp(DP, "g"), ".*")
  return new RegExp(`^${escaped}$`)
}

/** 剥 HTML 标签 */
export function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;|&ensp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

/** HTML → 粗文本：去脚本样式、块级标签换行、剥标签、解码实体、压缩空行 */
export function htmlToText(html) {
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

/** 执行 git 命令。maxBuffer 10MB 防大 diff/log 溢出；溢出时返回截断的部分输出而非空。 */
export function runGit(cwd, cmdArgs) {
  try {
    return execFileSync("git", cmdArgs, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\r/g, "")
  } catch (e) {
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER 时 e.stdout 含部分输出，截取前 200 行返回
    if (e.stdout) return String(e.stdout).trim().replace(/\r/g, "").split("\n").slice(0, 200).join("\n")
    return ""
  }
}
