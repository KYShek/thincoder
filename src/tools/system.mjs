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
  isDestructiveCommand,
  hasFileRedirection,
  insideGitRepo,
  globToRegex,
  normalizeEOL,
} from "./shared.mjs";
import { spawn, execFileSync } from "node:child_process";
import { readFile, readdir, stat, lstat } from "node:fs/promises";
import { join } from "node:path";

/** Maximum buffer size per stream (stdout / stderr) before truncation */
const MAX_STREAM_BUF = 2_000_000

// ====================================================================
// bash — command execution with safety gates
// ====================================================================

/**
 * Pre-execution safety checks for bash commands.
 * Three layers: file redirection → destructive commands → destructive git ops with uncommitted changes.
 * Throws with actionable guidance on failure.
 */
function checkBashSafety(command, cwd) {
  if (hasFileRedirection(command)) {
    throw new Error("File redirection via bash is not allowed — use the write/edit/insert_after tools instead")
  }
  if (shellSegments(command).some(isDestructiveCommand)) {
    throw new Error(
      "Destructive command blocked — use specific tools or confirm with the user first. " +
      "(If work was already destroyed, recover from auto-snapshot: checkpoint action=list then action=rewind.)"
    )
  }
  if (shellSegments(command).some(isDestructiveGitSegment)) {
    if (!insideGitRepo(cwd)) {
      throw new Error(`Refusing destructive git command: not a git repository: ${cwd}`)
    }
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (status) {
      throw new Error(
        `Refusing destructive git command: uncommitted changes exist.\n` +
        `First create a checkpoint (action=create) to protect current work, then commit or stash before the destructive operation.\n` +
        `(If uncommitted work was already lost, recover from the latest auto-snapshot: checkpoint action=list, then action=rewind.)\n\n${status}`
      )
    }
  }
}

/**
 * Build environment for child process.
 * Passes through all parent env vars, with non-interactive overrides (EDITOR/PAGER/TERM).
 * Sets PYTHONIOENCODING on Windows to override GBK default for Python scripts.
 */
function buildBashEnv() {
  const winCmd = process.platform === "win32"
  return {
    ...process.env,
    GIT_EDITOR: "true",
    EDITOR: "true",
    VISUAL: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    ...(winCmd ? { PYTHONIOENCODING: "utf-8" } : {}),
  }
}

/**
 * Platform-aware process tree kill.
 * POSIX: kill process group (spawned with detached=true).
 * Windows: taskkill /T to reach grandchildren (npm test's subprocesses, etc.).
 */
function killProcessTree(child) {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }) } catch {}
  } else {
    try { process.kill(-child.pid, "SIGKILL") } catch {}
    try { child.kill("SIGKILL") } catch {} // fallback: kill directly if group kill fails
  }
}

/**
 * Run a bash command: spawn, stream stdout/stderr with buffering and decoding,
 * enforce timeout and signal abort, return formatted result.
 *
 * Returns a promise that resolves to the formatted output string (stdout + stderr + status + truncation note).
 */
function runBash(command, cwd, { timeout, signal, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: buildBashEnv(),
    })

    const killTree = () => killProcessTree(child)

    // Separate decoders for stdout / stderr (same encoding in practice, but separate
    // collection is cleaner and lets the model locate errors via stderr quickly)
    const outDecoder = makeDecoder()
    const errDecoder = makeDecoder()
    let outBuf = ""
    let errBuf = ""
    let truncatedNote = ""

    child.stdout.on("data", (d) => {
      const s = sanitizeOutput(outDecoder(d))
      if (s) {
        onOutput?.(s)
        if (outBuf.length < MAX_STREAM_BUF) outBuf += s
        else if (!truncatedNote) truncatedNote =
          "\n[... output exceeded 2MB, remainder discarded — redirect to a file if you need the full output]"
      }
    })

    child.stderr.on("data", (d) => {
      const s = sanitizeOutput(errDecoder(d))
      if (s) {
        onOutput?.(s)
        if (errBuf.length < MAX_STREAM_BUF) errBuf += s
      }
    })

    const timer = setTimeout(killTree, timeout)
    if (signal) signal.addEventListener("abort", killTree, { once: true })

    child.on("error", (error) => {
      clearTimeout(timer)
      resolve(truncate(`Command failed: ${error.message}\n[stdout]:\n${outBuf || "(empty)"}`))
    })

    child.on("close", (code, exitSignal) => {
      clearTimeout(timer)
      // Flush decoder tails (trailing multi-byte sequences that incomplete buffers left pending)
      outBuf += sanitizeOutput(outDecoder(Buffer.alloc(0), true))
      errBuf += sanitizeOutput(errDecoder(Buffer.alloc(0), true))

      // Windows has no POSIX signals — check signal.aborted for user interrupts
      const status = (exitSignal || signal?.aborted)
        ? `killed: ${signal?.aborted ? "user interrupted" : "timeout"}`
        : `exit code ${code}`

      const parts = [`[stdout]:\n${outBuf.trim() || "(empty)"}`]
      if (errBuf.trim()) parts.push(`[stderr]:\n${errBuf.trim()}`)
      parts.push(`(${status})`)
      resolve(truncate(parts.join("\n\n") + truncatedNote))
    })
  })
}

// ====================================================================
// tool definitions
// ====================================================================

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
  outputPanel: true, // stream stdout/stderr to panel during execution, collapse to summary on completion
  async execute(args, ctx) {
    checkBashSafety(args.command, ctx.cwd)
    return runBash(args.command, ctx.cwd, {
      timeout: args.timeout ?? BASH_TIMEOUT_MS,
      signal: ctx.signal,
      onOutput: ctx.onOutput,
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

/** Recursively traverse files, yield relative paths (skip IGNORED_DIRS) */
async function* walkFiles(dir, rel = "") {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    // Skip ignored dirs AND symbolic links (symlinks to directories would cause infinite loops)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      yield* walkFiles(join(dir, e.name), relPath)
    } else {
      yield relPath
    }
  }
}

/** Glob to regex: **\/ matches zero or more directory levels, ** crosses directories, * within segment, ? single char within segment */

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
    let regex
    try {
      regex = new RegExp(args.pattern)
    } catch (e) {
      throw new Error(`grep pattern /${args.pattern}/ is not a valid regex: ${e.message}`)
    }
    const fileFilter = args.glob ? globToRegex(args.glob) : null
    const before = Math.max(0, Math.floor(args.before ?? 0))
    const after = Math.max(0, Math.floor(args.after ?? 0))
    const wantCtx = before > 0 || after > 0
    const hits = [] // { file, line(1-based), text }
    const fileLines = new Map() // file -> string[] (cached only when context lines requested)

    async function search(file) {
      let content
      try {
        // Large file guard: skip files over 10MB to prevent OOM
        const fst = await stat(file)
        if (fst.size > 10_000_000) return
        content = normalizeEOL(await readFile(file, "utf8"))
      } catch {
        return // Skip unreadable files; binary files will be read as UTF-8 and searched (may produce garbled matches)
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
      // Use lstat to avoid following symlinks — prevents ./evil → /etc from making grep scan the entire system
      let s
      try { s = await lstat(target) } catch { return }
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

    // No context: keep original path:line: content format
    if (!wantCtx) {
      return truncate(hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n"))
    }

    // With context: matching lines use ':', context lines use '-' (like ripgrep); overlapping ranges in same file are merged and de-duplicated
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
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") throw new Error(`ls: ${args.path ?? "."} — ${e.code === "ENOTDIR" ? "not a directory" : "not found"}`)
      throw e
    }
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
