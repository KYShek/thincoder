import { DESC, truncate, resolveInCwd, globToRegex, IGNORED_DIRS } from "./shared.mjs"
import { readFile, readdir } from "node:fs/promises"
import { stat, lstat } from "node:fs/promises"
import { join } from "node:path"

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
        // 大文件保护：超 10MB 跳过，防 OOM
        const fst = await stat(file)
        if (fst.size > 10_000_000) return
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
      // 用 lstat 不跟随符号链接——防 ./evil → /etc 时 grep 读遍 /etc
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
