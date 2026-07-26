/**
 * memory/code-index.mjs — 代码和文档的分块、语言检测、符号提取
 */

import { segmentCJK, CODE_EXTS, DOC_EXTS, SKIP_DIRS, BIG_FILE_LINES } from "./schema.mjs"

/** 推断文件语言（按扩展名） */
export function detectLanguage(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase()
  const map = {
    ".mjs": "javascript", ".js": "javascript", ".jsx": "jsx", ".ts": "typescript", ".tsx": "tsx",
    ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
    ".rb": "ruby", ".swift": "swift", ".kt": "kotlin",
    ".sh": "bash", ".bash": "bash", ".sql": "sql",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".json": "json",
    ".css": "css", ".html": "html", ".vue": "vue", ".svelte": "svelte",
    ".md": "markdown", ".mdc": "markdown",
  }
  return map[ext] ?? ext.slice(1)
}

/**
 * 用正则提取 JS/TS 文件的顶层符号声明（函数、类、const 导出等）。
 * 返回 [{ name, line, kind }]。
 */
export function extractSymbols(lines, ext) {
  const jsish = new Set([".mjs", ".js", ".ts", ".jsx", ".tsx"])
  if (!jsish.has(ext)) return []

  const symbols = []
  const text = lines.join("\n")
  const re = /(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|class\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+))/gm
  let m
  while ((m = re.exec(text))) {
    const name = m[1] || m[2] || m[3]
    if (!name || name[0] !== name[0].toLowerCase() && name.length < 2) continue
    const line = text.slice(0, m.index).split("\n").length
    symbols.push({ name, line, kind: m[1] ? "function" : m[2] ? "class" : "variable" })
  }
  return symbols
}

/** 提取 Python 文件的顶层 def/class。 */
export function extractPySymbols(lines) {
  const symbols = []
  const re = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm
  const text = lines.join("\n")
  let m
  while ((m = re.exec(text))) {
    symbols.push({ name: m[1], line: text.slice(0, m.index).split("\n").length, kind: text[m.index] === "c" ? "class" : "function" })
  }
  return symbols
}

/**
 * 将一个文件拆成代码块。小文件整文件一块；大文件按符号切分，符号间的内容并入前一个符号块。
 * 每个块会额外带上符号前的 JSDoc / docstring 注释，提升搜索质量。
 */
export function chunkCode(lines, filepath) {
  const ext = filepath.slice(filepath.lastIndexOf(".")).toLowerCase()
  const chunks = []

  if (lines.length <= BIG_FILE_LINES) {
    const doc = extractLeadingDoc(lines, 1, ext)
    const content = (doc ? doc + "\n" : "") + lines.join("\n").trimEnd()
    chunks.push({ name: filepath, line_start: 1, line_end: lines.length, content })
    return chunks
  }

  const symbols = ext === ".py" ? extractPySymbols(lines) : extractSymbols(lines, ext)
  if (symbols.length <= 1) {
    const doc = extractLeadingDoc(lines, 1, ext)
    const content = (doc ? doc + "\n" : "") + lines.join("\n").trimEnd()
    chunks.push({ name: filepath, line_start: 1, line_end: lines.length, content })
    return chunks
  }

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]
    const start = sym.line
    const end = i + 1 < symbols.length ? symbols[i + 1].line - 1 : lines.length
    if (start > end) continue
    const doc = extractLeadingDoc(lines, start, ext)
    const body = lines.slice(start - 1, end).join("\n").trimEnd()
    const content = (doc ? doc + "\n" : "") + body
    if (!content) continue
    chunks.push({ name: `${filepath}:${sym.name}`, line_start: start, line_end: end, content })
  }
  return chunks
}

/**
 * 提取指定行之前的 JSDoc / docstring 注释。
 * JS/TS: 向前扫描 /** ... *​/ 或 // 连续注释行
 * Python: 符号定义行的下一行开始找 """...""" docstring
 */
export function extractLeadingDoc(lines, lineNum, ext) {
  if (ext === ".py") {
    if (lineNum >= lines.length) return ""
    const next = lines[lineNum]
    const m = next?.match(/^\s*"""(.+?)"""\s*$/)
    if (m) return m[1].trim()
    if (/^\s*"""\s*$/.test(next)) {
      const parts = []
      for (let i = lineNum + 1; i < lines.length && i < lineNum + 8; i++) {
        if (/^\s*"""\s*$/.test(lines[i])) break
        parts.push(lines[i].trim())
      }
      const text = parts.join(" ").trim()
      return text.length > 0 && text.length < 300 ? text : ""
    }
    return ""
  }

  const jsish = new Set([".mjs", ".js", ".ts", ".jsx", ".tsx"])
  if (!jsish.has(ext)) return ""

  const parts = []
  let i = lineNum - 2
  if (i >= 0 && /^\s*\*\/\s*$/.test(lines[i])) {
    while (i >= 0) {
      const line = lines[i].trim()
      if (/^\s*\/\*\*/.test(line)) {
        parts.unshift(line.replace(/^\s*\/\*\*\s*/, "").replace(/\s*\*\/\s*$/, "").trim())
        break
      }
      parts.unshift(line.replace(/^\s*\*\s?/, "").trim())
      i--
    }
  } else {
    while (i >= 0 && /^\s*\/\//.test(lines[i])) {
      parts.unshift(lines[i].replace(/^\s*\/\/\s*/, "").trim())
      i--
    }
  }

  const text = parts.join(" ").trim()
  return text.length > 0 && text.length < 300 ? text : ""
}

/** 将控制权交还给事件循环一个 tick（让键盘输入有机会被处理） */
export function yieldTick() {
  return new Promise((r) => setTimeout(r, 0))
}

/** 单文件入索引：删除旧块 → 分块 → 插入新块 */
export function _upsertCodeFile(memory, origin, rel, lines, lang, mtimeMs) {
  const chunks = chunkCode(lines, rel)
  memory.db.exec("BEGIN")
  try {
    memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(origin, rel)
    const insert = memory.db.prepare(`
      INSERT INTO code_chunks (origin, path, language, chunk_type, symbol_name, content, line_start, line_end, mtime_ms, seg_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const c of chunks) {
      const isFile = c.name === rel
      insert.run(origin, rel, lang, isFile ? "file" : "symbol", isFile ? "" : c.name.slice(rel.length + 1), c.content, c.line_start, c.line_end, mtimeMs, segmentCJK(c.content))
    }
    memory.db.exec("COMMIT")
  } catch (e) {
    memory.db.exec("ROLLBACK")
    throw e
  }
}

/**
 * 按 ## 标题切分 markdown 文件。每个 ## section 独立入索引，
 * 标题路径做 heading（如 "README.md > 部署 > Docker"），方便检索定位。
 */
export function chunkMarkdown(lines, filepath) {
  const chunks = []
  let start = 1
  let heading = filepath

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4})\s+(.+)/)
    if (m) {
      if (i > start) {
        chunks.push({ heading, line_start: start, line_end: i, content: lines.slice(start - 1, i).join("\n").trimEnd() })
      }
      heading = `${filepath} > ${m[2].trim()}`
      start = i + 1
    }
  }
  if (start <= lines.length) {
    chunks.push({ heading, line_start: start, line_end: lines.length, content: lines.slice(start - 1).join("\n").trimEnd() })
  }
  return chunks.filter((c) => c.content)
}

export function _upsertDocFile(memory, origin, rel, lines, mtimeMs) {
  const chunks = chunkMarkdown(lines, rel)
  const lang = rel.endsWith(".rst") ? "rst" : rel.endsWith(".adoc") ? "asciidoc" : rel.endsWith(".txt") ? "text" : "markdown"
  memory.db.exec("BEGIN")
  try {
    memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(origin, rel)
    const insert = memory.db.prepare(`
      INSERT INTO doc_chunks (origin, path, language, heading, content, line_start, line_end, mtime_ms, seg_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const c of chunks) {
      insert.run(origin, rel, lang, c.heading, c.content, c.line_start, c.line_end, mtimeMs, segmentCJK(c.content))
    }
    memory.db.exec("COMMIT")
  } catch (e) {
    memory.db.exec("ROLLBACK")
    throw e
  }
}
