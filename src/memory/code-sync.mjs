/**
 * memory/code-sync.mjs — 代码索引同步、检索、增量更新
 */

import { readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { embed, cosine, toBlob, fromBlob } from "../embedding.mjs"
import { CODE_EXTS, DOC_EXTS, SKIP_DIRS } from "./schema.mjs"
import { buildFtsQuery, ensureEmbeddings } from "./core.mjs"
import { detectLanguage, _upsertCodeFile, _upsertDocFile, yieldTick } from "./code-index.mjs"

/**
 * git 驱动增量索引：用 git diff 找出上次索引以来的变更文件，
 * 只重建这些文件的 FTS5 块（不碰向量）。比全量 mtime 扫描快一个数量级。
 * 返回 { updated, removed, skipped } 或 null（git 不可用）。
 */
export async function gitSync(memory, dir, { onProgress } = {}) {
  const { execSync } = await import("node:child_process")
  const opts = { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }

  let head
  try { head = execSync("git rev-parse HEAD", opts).trim() } catch { return null }

  const stored = memory.db.prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`).get()?.value
  if (!stored) return null

  let diffOut
  try {
    const committed = execSync(`git diff --name-only --diff-filter=ACMRTD ${stored} HEAD`, opts).trim()
    const dirty = execSync(`git diff --name-only --diff-filter=ACMRTD`, opts).trim()
    const lines = [...new Set([...committed.split("\n").filter(Boolean), ...dirty.split("\n").filter(Boolean)])]
    diffOut = lines
  } catch {
    return null
  }

  if (diffOut.length > 200) return null

  let updated = 0, removed = 0, skipped = 0, failed = 0
  const errors = []
  for (let i = 0; i < diffOut.length; i++) {
    const rel = diffOut[i].replaceAll("\\", "/")
    const abs = join(dir, rel)
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase()

    const pathDirs = rel.split("/")
    if (pathDirs.some((d) => SKIP_DIRS.has(d) || d.startsWith("."))) continue

    if (!CODE_EXTS.has(ext) && !DOC_EXTS.has(ext)) { skipped++; continue }

    try {
      const text = await readFile(abs, "utf8")
      const lines = text.split("\n")
      if (CODE_EXTS.has(ext)) {
        const lang = detectLanguage(abs)
        let mtimeMs = 0
        try { mtimeMs = Math.floor((await stat(abs)).mtimeMs) } catch { /* 新文件 */ }
        _upsertCodeFile(memory, dir, rel, lines, lang, mtimeMs)
      } else {
        let mtimeMs = 0
        try { mtimeMs = Math.floor((await stat(abs)).mtimeMs) } catch { /* 新文件 */ }
        _upsertDocFile(memory, dir, rel, lines, mtimeMs)
      }
      updated++
    } catch (e) {
      const isDeleted = e.code === "ENOENT"
      if (isDeleted) {
        if (CODE_EXTS.has(ext)) memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(dir, rel)
        else memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(dir, rel)
        removed++
      } else {
        failed++
        if (errors.length < 5) errors.push(`${rel}: ${e.message}`)
      }
    }
    if (onProgress && i % 5 === 0) {
      onProgress({ phase: "index", current: i + 1, total: diffOut.length, updated, removed, skipped })
    }
  }

  if (failed === 0) {
    memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_indexed_commit', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(head)
  }

  onProgress?.({ phase: "done", total: diffOut.length, updated, removed, skipped, failed })
  return { updated, removed, skipped, failed, errors }
}

/**
 * 同步代码索引：扫描 dir 下所有源文件 → 分块 → upsert 到 code_chunks。
 * 按 mtime 增量——只重建变更过的文件块。
 */
export async function codeSync(memory, dir, { onProgress } = {}) {
  const files = []
  const { readdir } = await import("node:fs/promises")
  async function walk(d) {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        await walk(join(d, e.name))
      } else if (e.isFile()) {
        const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase()
        if (CODE_EXTS.has(ext)) files.push(join(d, e.name))
      }
    }
  }
  await walk(dir)

  const indexed = new Map(
    memory.db.prepare(`SELECT path, mtime_ms FROM code_chunks WHERE origin = ?`).all(dir).map((r) => [r.path, r.mtime_ms])
  )
  const seen = new Set()

  onProgress?.({ phase: "scan", total: files.length })

  let updated = 0, removed = 0, skipped = 0, failed = 0
  const errors = []
  for (let i = 0; i < files.length; i++) {
    const abs = files[i]
    const rel = abs.slice(dir.length + 1).replaceAll("\\", "/")
    seen.add(rel)

    let mtimeMs
    try { mtimeMs = Math.floor((await stat(abs)).mtimeMs) } catch { continue }
    if (indexed.get(rel) === mtimeMs) {
      skipped++
      continue
    }

    try {
      const text = await readFile(abs, "utf8")
      const lines = text.split("\n")
      const lang = detectLanguage(abs)
      _upsertCodeFile(memory, dir, rel, lines, lang, mtimeMs)
      updated++
    } catch (e) {
      failed++
      if (errors.length < 5) errors.push(`${rel}: ${e.message}`)
    }
    await yieldTick()

    if (onProgress && i % 10 === 0) {
      onProgress({ phase: "index", current: i + 1, total: files.length, updated, removed, skipped, failed })
    }
  }

  for (const stale of indexed.keys()) {
    if (!seen.has(stale)) {
      memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(dir, stale)
      removed++
    }
  }

  onProgress?.({ phase: "done", total: files.length, updated, removed, skipped, failed })
  markIndexedCommit(memory, dir)
  return { updated, removed, skipped, failed, errors, total: files.length }
}

/** 记录当前 HEAD 作为索引锚点（gitSync 增量 diff 基准）；非 git 仓库静默跳过 */
export async function markIndexedCommit(memory, dir) {
  try {
    const { execSync } = await import("node:child_process")
    const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim()
    memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_indexed_commit', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(head)
  } catch { /* 非 git 仓库或 git 不可用，跳过 */ }
}

/**
 * 代码检索：FTS5(BM25) + 可选向量余弦，RRF 合并。
 * 无 embedder 时退化为纯 FTS；ftsQuery 为空且有 embedder 时退化为纯向量。
 */
export async function codeSearch(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery && !memory.embedder) return []

  const ftsOriginFilter = memory.codeOrigin ? `AND c.origin = ?` : ""
  const vecOriginFilter = memory.codeOrigin ? `AND origin = ?` : ""
  const originParams = memory.codeOrigin ? [memory.codeOrigin] : []

  const ftsList = ftsQuery ? memory.db.prepare(`
    SELECT c.rowid, c.path, c.language, c.symbol_name, c.content, c.line_start, c.line_end, bm25(code_chunks_fts) AS rank
    FROM code_chunks_fts JOIN code_chunks c ON c.rowid = code_chunks_fts.rowid
    WHERE code_chunks_fts MATCH ? ${ftsOriginFilter}
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, ...originParams, Math.max(limit * 4, 20)) : []

  if (!memory.embedder) return ftsList.slice(0, limit)

  await ensureEmbeddings(memory)
  const [qvec] = await embed(memory.embedder, [query])
  const rows = memory.db.prepare(`SELECT rowid, embedding FROM code_chunks WHERE embedding IS NOT NULL ${vecOriginFilter}`).all(...originParams)
  const vecList = rows
    .map((r) => ({ rowid: r.rowid, score: cosine(qvec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 20))

  const K = 60
  const scores = new Map()
  ftsList.forEach((r, i) => scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1 / (K + i + 1)))
  vecList.forEach((r, i) => scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1 / (K + i + 1)))

  const fetchChunk = memory.db.prepare(`
    SELECT path, language, symbol_name, content, line_start, line_end FROM code_chunks WHERE rowid = ?
  `)
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rowid]) => fetchChunk.get(rowid))
    .filter(Boolean)
}

/** 惰性补算 code_chunks 缺失的向量 */
export async function ensureCodeEmbeddings(memory) {
  if (!memory.embedder) return
  const modelKey = memory.embedder.model
  const stored = memory.db.prepare(`SELECT value FROM meta WHERE key = 'code_embedding_model'`).get()?.value
  if (stored !== modelKey) {
    memory.db.prepare(`UPDATE code_chunks SET embedding = NULL`).run()
    memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('code_embedding_model', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(modelKey)
  }

  const pending = memory.db.prepare(`SELECT rowid, path, symbol_name, content FROM code_chunks WHERE embedding IS NULL LIMIT 64`).all()
  if (pending.length === 0) return

  const texts = pending.map((r) => `${r.path}${r.symbol_name ? " :: " + r.symbol_name : ""}\n${r.content.slice(0, 2000)}`)
  const vecs = await embed(memory.embedder, texts)

  const update = memory.db.prepare(`UPDATE code_chunks SET embedding = ? WHERE rowid = ?`)
  pending.forEach((r, i) => update.run(toBlob(vecs[i]), r.rowid))
}

/** 生成 code_search 工具（只读）。 */
export function codeSearchTool(memory) {
  return {
    name: "code_search",
    description:
      "Search the project's source code for relevant code. Use this to find functions, classes, or code patterns across the codebase. Supports natural language queries and code snippets. Returns matching code chunks with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language or code snippet to search for" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    readonly: true,
    async execute(args) {
      const results = await codeSearch(memory, args.query, { limit: args.limit ?? 5 })
      if (results.length === 0) return "(no matching code)"
      return results.map((r) =>
        `${r.path}${r.symbol_name ? ` :: ${r.symbol_name}` : ""} (L${r.line_start}-L${r.line_end}):\n${r.content.slice(0, 2000)}`
      ).join("\n\n---\n\n")
    },
  }
}

/**
 * 单文件增量重索引：write/edit/delete 后调用，只重建这一条路径。
 */
export async function reindexFile(memory, cwd, absPath) {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase()
  const rel = relative(cwd, absPath).replaceAll("\\", "/")
  if (rel === ".." || rel.startsWith("../")) return
  const dirs = rel.split("/").slice(0, -1)
  if (dirs.some((d) => SKIP_DIRS.has(d) || d.startsWith("."))) return

  let text
  try { text = await readFile(absPath, "utf8") } catch {
    if (CODE_EXTS.has(ext)) memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(cwd, rel)
    else if (DOC_EXTS.has(ext)) memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(cwd, rel)
    return
  }
  const lines = text.split("\n")

  if (CODE_EXTS.has(ext)) {
    const lang = detectLanguage(absPath)
    let mtimeMs = 0
    try { mtimeMs = Math.floor((await stat(absPath)).mtimeMs) } catch { /* 新文件 */ }
    _upsertCodeFile(memory, cwd, rel, lines, lang, mtimeMs)
  } else if (DOC_EXTS.has(ext)) {
    let mtimeMs = 0
    try { mtimeMs = Math.floor((await stat(absPath)).mtimeMs) } catch { /* 新文件 */ }
    _upsertDocFile(memory, cwd, rel, lines, mtimeMs)
  }
  if (memory.embedder) {
    try { await ensureEmbeddings(memory) } catch { /* embedding 失败不阻塞 */ }
  }
}
