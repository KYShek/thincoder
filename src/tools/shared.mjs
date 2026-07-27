/**
 * tools/shared.mjs — shared tool utilities, constants, OpenAI schema conversion
 * Imported by tools/file.mjs / system.mjs / web.mjs / git.mjs
 */

import { spawn, execFileSync, execFile } from "node:child_process"
import { readFileSync, existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DESC = (name) => readFileSync(join(__dirname, "..", "tools", `${name}.md`), "utf8")

export const MAX_READ_LINES = 2000
export const MAX_OUTPUT_CHARS = 200_000

const ENCODING_DETECT_MAX_TRIM = 3
const SYNTAX_CHECK_TIMEOUT = 10000
export const BASH_TIMEOUT_MS = 120_000
export const MAX_RESPONSE_BODY_BYTES = 5_000_000
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage"])

/** Convert to OpenAI tools parameter format */
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

/** Strip ANSI escape sequences */
export function sanitizeOutput(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[\x40-\x7E]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

/** Truncate text to max chars, appending a truncation notice */
export function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n[... truncated: ${text.length - max} chars omitted — redirect to a file if you need the full output]`
}

/** Read response body with a byte limit */
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

/** Streaming decoder: encoding sniffing ASCII→UTF-8→GBK.
 *  Each call creates an independent decoder instance — must not be shared across parallel streams (internal decoder state accumulates). */
export function makeDecoder() {
  let decoder = null
  let pending = Buffer.alloc(0)
  return (d, flush = false) => {
    pending = Buffer.concat([pending, d])
    if (!decoder) {
      const hasHighByte = pending.some((b) => b >= 0x80)
      if (!hasHighByte) { const s = pending.toString("ascii"); pending = Buffer.alloc(0); return s }
      for (let trim = 0; trim <= ENCODING_DETECT_MAX_TRIM && !decoder; trim++) {
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

/** Single-file git diff. Silently returns empty on failure. Large diffs that exceed maxBuffer are truncated rather than swallowed. */
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
    // maxBuffer overflow: e.stdout contains partial collected output; other errors (non-git repo etc.) return empty
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && e.stdout) {
      const lines = e.stdout.toString().split("\n")
      return lines.slice(0, 200).join("\n") + `\n... (diff too large, showing first 200 of more lines)`
    }
    return ""
  }
}

/** Auto syntax check after file modification */
export async function autoSyntaxCheck(abs) {
  if (!/\.(m?js)$/i.test(abs)) return ""
  try {
    await new Promise((resolve, reject) => {
      const child = execFile("node", ["--check", abs], { timeout: SYNTAX_CHECK_TIMEOUT, stdio: ["ignore", "pipe", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (d) => { stderr += d.toString() })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) resolve()
        else {
          const err = new Error(stderr.trim() || `node --check exited with code ${code}`)
          err.stderr = stderr
          reject(err)
        }
      })
    })
    return "\nSyntax: OK"
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || "").toString().split("\n").slice(0, 3).join("\n")
    return `\nSyntax: FAILED — ${err}\n(If this file was corrupted by a bad edit, recover it from a checkpoint: checkpoint action=list then action=rewind with the latest id.)`
  }
}

/** Resolve realpath by walking up the directory tree */
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
/** Resolve cwd to realpath, cached */
export function realCwd(cwd) {
  if (!realCwdCache.has(cwd)) realCwdCache.set(cwd, realpathNearest(resolve(cwd)))
  return realCwdCache.get(cwd)
}

/** Assert that a resolved path is inside cwd; throws on escape */
export function assertInside(cwd, resolved, p) {
  const rel = relative(cwd, resolved)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error(`Access denied outside working directory: ${p}`)
  }
}

/** Resolve a user-supplied path relative to cwd, asserting it stays within cwd */
export function resolveInCwd(ctx, p) {
  const cwd = realCwd(ctx.cwd)
  const resolved = resolve(cwd, p)
  assertInside(cwd, resolved, p)
  const real = realpathNearest(resolved)
  assertInside(cwd, real, p)
  return resolved
}

/** Coarse segmentation for destructive pre-check (also splits on > >> < so destructive detection still works through redirection) */
export function shellSegments(command) {
  return command.split(/&&|\|\||>>|\$\(|[;|\n<>]|`|[(]/)
}

/** Detect shell output/input redirection (> >> < followed by filename) — not excluded inside quotes, conservative block */
export function hasFileRedirection(command) {
  return /(^|[\s;&|])>{1,2}\s*\S/.test(command) || /(^|[\s;&|])<\s*\S/.test(command)
}

/** Whether a single command segment is a destructive non-git command (conservative: prefer false positives) */
export function isDestructiveCommand(seg) {
  const s = seg
  // rm with both recursive (-r/-R) and force (-f) flags: -rf / -fr / -r -f / -Rf etc.
  if (/\brm\b/.test(s) && /\s-\S*r/i.test(s) && /\s-\S*f/i.test(s)) return true
  if (/\brmdir\b/i.test(s)) return true
  if (/\bdel\b/i.test(s) && /\/f\b/i.test(s)) return true
  if (/\brd\b/i.test(s) && /\/s\b/i.test(s)) return true
  // format called as a command (exclude --format= option false positives)
  if (/\bformat\b\s+\S/i.test(s) && !/--format\b/i.test(s)) return true
  if (/\bshred\b/i.test(s)) return true
  if (/\bdd\b/.test(s) && /\bof=/i.test(s)) return true
  if (/\bDROP\s+TABLE\b/i.test(s)) return true
  if (/\bDELETE\s+FROM\b/i.test(s)) return true
  if (/\bTRUNCATE\b/i.test(s)) return true
  return false
}

/** Whether a single command segment destroys uncommitted changes */
export function isDestructiveGitSegment(seg) {
  if (!/^\s*git\s/.test(seg)) return false
  if (/\scheckout\s+(?:--|\.(?:\s|$))/.test(seg)) return true
  if (/\sreset\s+--hard\b/.test(seg)) return true
  if (/\sclean\s+-\S*f/.test(seg)) return true
  if (/\srestore\s/.test(seg) && (/--worktree/.test(seg) || !/--staged/.test(seg))) return true
  return false
}

/** Whether cwd is inside a git repository */
export function insideGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })
    return true
  } catch { return false }
}

/** Convert glob pattern to regex */
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

/** Strip HTML tags */
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

/** HTML → plain text: strip scripts/styles, newline block tags, strip tags, decode entities, compress blank lines */
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
    .replace(/&amp;/g, "&") // &amp; must be decoded last, otherwise &amp;lt; gets double-decoded to <
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

/** Execute a git command. maxBuffer 10MB prevents large diff/log overflow; on overflow, returns truncated partial output rather than empty. */
export function runGit(cwd, cmdArgs) {
  try {
    return execFileSync("git", cmdArgs, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\r/g, "")
  } catch (e) {
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER: e.stdout contains partial output, return first 200 lines
    if (e.stdout) return String(e.stdout).trim().replace(/\r/g, "").split("\n").slice(0, 200).join("\n")
    return ""
  }
}
