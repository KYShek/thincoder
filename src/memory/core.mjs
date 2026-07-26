/**
 * memory/core.mjs — 记忆 CRUD、混合检索、embedding 管理
 */

import { parseEntry, serializeEntry, entryFilename } from "../markdown.mjs"
import { embed, cosine, toBlob, fromBlob } from "../embedding.mjs"
import { readFile, stat, readdir, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { segmentCJK, VALID_TYPES, SCHEMA_VERSION } from "./schema.mjs"

/**
 * 写入一条记忆。entry: { type, title, content, tags? }
 * 返回新条目 id。
 */
export async function put(memory, { type, title, content, tags = "" }) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid memory type "${type}"; expected one of: ${[...VALID_TYPES].join(", ")}`)
  }
  if (!title || !content) throw new Error("memory entry requires title and content")
  const now = Date.now()
  const stmt = memory.db.prepare(
    `INSERT INTO entries (type, title, content, tags, seg_title, seg_content, seg_tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const info = stmt.run(type, title, content, tags, segmentCJK(title), segmentCJK(content), segmentCJK(tags), now, now)
  return Number(info.lastInsertRowid)
}

/**
 * 混合检索：FTS5(BM25) + 向量余弦，RRF(k=60) 合并排序。
 * 无 embedder 时退化为纯 FTS。结果带 layer 标记。
 * 返回 [{ id, layer, type, title, content, tags, rank }]
 */
export async function search(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  const ftsList = ftsQuery ? ftsSearch(memory, ftsQuery, Math.max(limit * 4, 20)) : []

  if (!memory.embedder) return ftsList.slice(0, limit)

  // ---- 向量通道 ----
  await ensureEmbeddings(memory)
  const [qvec] = await embed(memory.embedder, [query])
  const vecFilter = memory.projectOrigin ? `AND (layer = 'team' OR origin = ?)` : ""
  const vecParams = memory.projectOrigin ? [memory.projectOrigin] : []
  const rows = memory.db.prepare(`
    SELECT 'personal:' || id AS uid, embedding FROM entries WHERE embedding IS NOT NULL
    UNION ALL
    SELECT layer || ':' || path AS uid, embedding FROM files WHERE embedding IS NOT NULL ${vecFilter}
  `).all(...vecParams)
  const vecList = rows
    .map((r) => ({ id: r.uid, score: cosine(qvec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 20))

  // ---- RRF 合并 ----
  const K = 60
  const scores = new Map()
  ftsList.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (K + i + 1)))
  vecList.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (K + i + 1)))

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const entry = fetchEntry(memory, id)
      return entry ? { ...entry, rrf: score } : null
    })
    .filter(Boolean)
}

/** 纯 FTS 检索（两表合并，按 bm25 排序），RRF 的位置输入 */
export function ftsSearch(memory, ftsQuery, limit) {
  const personal = memory.db.prepare(`
    SELECT e.id, e.type, e.title, e.content, e.tags, bm25(entries_fts) AS rank
    FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
    WHERE entries_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, limit).map((r) => ({ ...r, layer: "personal", id: `personal:${r.id}` }))

  const originFilter = memory.projectOrigin ? `AND (f.layer = 'team' OR f.origin = ?)` : ""
  const originParams = memory.projectOrigin ? [ftsQuery, memory.projectOrigin, limit] : [ftsQuery, limit]
  const files = memory.db.prepare(`
    SELECT f.layer, f.path, f.type, f.title, f.content, f.tags, f.author, bm25(files_fts) AS rank
    FROM files_fts JOIN files f ON f.rowid = files_fts.rowid
    WHERE files_fts MATCH ? ${originFilter}
    ORDER BY rank LIMIT ?
  `).all(...originParams).map((r) => ({ ...r, id: `${r.layer}:${r.path}` }))

  return [...personal, ...files].sort((a, b) => a.rank - b.rank).slice(0, limit)
}

/** 按统一 id 取完整条目（personal:<n> / project:<path> / team:<path>） */
export function fetchEntry(memory, uid) {
  const [layer, ...rest] = uid.split(":")
  const key = rest.join(":")
  if (layer === "personal") {
    const r = memory.db.prepare(`SELECT id, type, title, content, tags FROM entries WHERE id = ?`).get(Number(key))
    return r ? { ...r, layer, id: uid } : null
  }
  const r = memory.db.prepare(`SELECT type, title, content, tags, author FROM files WHERE layer = ? AND path = ?`).get(layer, key)
  return r ? { ...r, layer, id: uid } : null
}

/**
 * 惰性 embedding：把还没有向量的条目批量补算落库（首次慢、后续零成本）。
 * 检测到 embedding 模型变更时，清空全部向量重建。
 */
export async function ensureEmbeddings(memory) {
  const modelKey = memory.embedder.model
  const stored = memory.db.prepare(`SELECT value FROM meta WHERE key = 'embedding_model'`).get()?.value
  if (stored !== modelKey) {
    memory.db.prepare(`UPDATE entries SET embedding = NULL`).run()
    memory.db.prepare(`UPDATE files SET embedding = NULL`).run()
    memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('embedding_model', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(modelKey)
  }

  const pendingEntries = memory.db.prepare(`SELECT id, title, content FROM entries WHERE embedding IS NULL LIMIT 256`).all()
  const pendingFiles = memory.db.prepare(`SELECT rowid, title, content FROM files WHERE embedding IS NULL LIMIT 256`).all()
  if (pendingEntries.length + pendingFiles.length === 0) {
    // 记忆不算 pending，也补一下代码和文档块的向量
    await (await import("./code-sync.mjs")).ensureCodeEmbeddings(memory)
    await (await import("./docs.mjs")).ensureDocEmbeddings(memory)
    return
  }

  const items = [...pendingEntries, ...pendingFiles]
  const texts = items.map((r) => `${r.title}\n${r.content.slice(0, 2000)}`)
  const vecs = await embed(memory.embedder, texts)

  const updateEntry = memory.db.prepare(`UPDATE entries SET embedding = ? WHERE id = ?`)
  pendingEntries.forEach((r, i) => updateEntry.run(toBlob(vecs[i]), r.id))
  const updateFile = memory.db.prepare(`UPDATE files SET embedding = ? WHERE rowid = ?`)
  pendingFiles.forEach((r, i) => updateFile.run(toBlob(vecs[pendingEntries.length + i]), r.rowid))

  // 每批嵌入后也补一下代码和文档块
  await (await import("./code-sync.mjs")).ensureCodeEmbeddings(memory)
  await (await import("./docs.mjs")).ensureDocEmbeddings(memory)
}

/**
 * 写入一条 markdown 记忆到指定层目录（project/team），并即时索引。
 * 只写文件——project 层绝不替用户的项目仓库做 git 操作；
 * team 层的 commit+push 由 gitmem.mjs 负责。
 * 返回文件名。
 */
export async function putMarkdown(memory, { layer, dir, type, title, content, tags = [], author = "unknown" }) {
  if (layer !== "project" && layer !== "team") throw new Error(`invalid markdown layer: ${layer}`)
  const filename = entryFilename(title)
  const markdown = serializeEntry({ type, title, tags, author }, content)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), markdown, "utf8")
  await indexMarkdownFile(memory, { layer, dir, filename })
  return filename
}

/**
 * 同步一个 markdown 目录到索引：新增/变更（按 mtime）重建索引，消失的条目从索引删除。
 */
export async function syncDir(memory, { layer, dir }) {
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
  } catch {
    names = []
  }

  const indexed = new Map(
    memory.db.prepare(`SELECT path, mtime_ms FROM files WHERE layer = ?`).all(layer).map((r) => [r.path, r.mtime_ms]),
  )

  let added = 0, updated = 0, skipped = 0
  for (const filename of names) {
    const mtimeMs = Math.floor((await stat(join(dir, filename))).mtimeMs)
    const old = indexed.get(filename)
    const isNew = old === undefined
    if (!isNew && old === mtimeMs) continue
    try {
      await indexMarkdownFile(memory, { layer, dir, filename, mtimeMs })
    } catch {
      skipped++
      indexed.delete(filename)
      continue
    }
    if (isNew) added++
    else updated++
    indexed.delete(filename)
  }

  let removed = 0
  for (const stale of indexed.keys()) {
    memory.db.prepare(`DELETE FROM files WHERE layer = ? AND path = ?`).run(layer, stale)
    removed++
  }
  return { added, updated, removed, skipped }
}

/** 解析单个 .md 并 upsert 进 files 表 */
export async function indexMarkdownFile(memory, { layer, dir, filename, mtimeMs }) {
  const abs = join(dir, filename)
  const mtime = mtimeMs ?? Math.floor((await stat(abs)).mtimeMs)
  const { meta, content } = parseEntry(await readFile(abs, "utf8"))
  const tags = meta.tags.join(" ")
  memory.db.prepare(`
    INSERT INTO files (layer, path, type, title, content, tags, author, mtime_ms, origin, seg_title, seg_content, seg_tags, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (layer, path) DO UPDATE SET
      type=excluded.type, title=excluded.title, content=excluded.content, tags=excluded.tags,
      author=excluded.author, mtime_ms=excluded.mtime_ms, origin=excluded.origin,
      seg_title=excluded.seg_title, seg_content=excluded.seg_content, seg_tags=excluded.seg_tags,
      updated_at=excluded.updated_at
  `).run(
    layer, filename, meta.type, meta.title, content, tags, meta.author, mtime, dir,
    segmentCJK(meta.title), segmentCJK(content), segmentCJK(tags), Date.now(),
  )
}

/** 列出新条目，可按 type 过滤 */
export async function list(memory, { type, limit = 50 } = {}) {
  if (type) {
    if (!VALID_TYPES.has(type)) throw new Error(`Invalid memory type "${type}"`)
    return memory.db
      .prepare(`SELECT id, type, title, content, tags, updated_at FROM entries WHERE type = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(type, limit)
  }
  return memory.db
    .prepare(`SELECT id, type, title, content, tags, updated_at FROM entries ORDER BY updated_at DESC LIMIT ?`)
    .all(limit)
}

/** 删除一条记忆。返回是否删除成功 */
export async function remove(memory, id) {
  const info = memory.db.prepare(`DELETE FROM entries WHERE id = ?`).run(id)
  return info.changes > 0
}

/**
 * 构造 FTS5 查询：先对查询做同样的 CJK 分字，再按空白/标点切词，
 * 每个词加引号，OR 连接（AND 太严格：自然语言查询一词不中全灭）。
 */
export function buildFtsQuery(query) {
  const terms = segmentCJK(query)
    .split(/[\s,，。、;；!！?？()（）"`]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16)
  if (terms.length === 0) return ""
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ")
}
