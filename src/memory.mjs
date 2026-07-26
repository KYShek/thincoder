/**
 * memory.mjs — 记忆系统（扩展位 ⭐）
 * v1：node:sqlite + FTS5 单机实现，BM25 排序，零依赖。
 * v2 团队版：同一接口 + git 同步层 + 向量检索 + RRF，调用方无感。
 *
 * entry.type ∈ rule | knowledge | decision | pattern（对齐团队记忆四类内容）
 *
 * 中文检索方案：FTS5 unicode61 分词 + CJK 逐字加空格（写入和查询两侧同样处理）。
 * 效果：中文按字索引，"分号" 这类双字词也能命中；ASCII 仍按整词。
 * 语义层面的匹配（如 "规范" vs "风格"）留给 v2 向量检索。
 */

import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { parseEntry, serializeEntry, entryFilename } from "./markdown.mjs"
import { embed, cosine, toBlob, fromBlob } from "./embedding.mjs"
import { commitAndPush } from "./gitmem.mjs"

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])
const SCHEMA_VERSION = 8

// 代码索引：源码文件扩展名
const CODE_EXTS = new Set([".mjs", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".swift", ".kt", ".sh", ".bash", ".sql", ".yaml", ".yml", ".toml", ".json", ".css", ".html", ".vue", ".svelte"])
// 文档索引：markdown / 纯文本（分开索引，便于 LLM 区分"设计规范"和"现存代码"）
const DOC_EXTS = new Set([".md", ".mdc", ".txt", ".rst", ".adoc"])
// 总是跳过的目录名
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage", "__pycache__", ".venv", "venv", "target", ".next", ".nuxt", ".svelte-kit"])
// 大文件阈值（行数）：超过此行数按符号分块，否则整文件入索引
const BIG_FILE_LINES = 2000

/**
 * 打开/初始化记忆库。dbPath 不存在会自动创建。
 * 返回的 memory 对象即接口，后续函数的第一个参数都是它。
 */
export function createMemory({ dbPath }) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // WAL 读写不互锁（TUI 检索和后台索引可并发）；busy_timeout 防多进程同库直接 SQLITE_BUSY
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(`PRAGMA busy_timeout = 3000`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('rule','knowledge','decision','pattern')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      seg_title TEXT NOT NULL DEFAULT '',
      seg_content TEXT NOT NULL DEFAULT '',
      seg_tags TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  migrate(db)
  return { db }
}

/** 按 user_version 逐步迁移。整体单事务——任何一步失败都回滚，不留半成品 schema */
function migrate(db) {
  const { user_version: version } = db.prepare(`PRAGMA user_version`).get()
  if (version >= SCHEMA_VERSION) return

  db.exec("BEGIN IMMEDIATE")
  try {
  if (version < 2) {
    // v1(trigram) 或空库 → v2(unicode61 + CJK 逐字)：重建 FTS 和触发器
    db.exec(`
      DROP TRIGGER IF EXISTS entries_ai;
      DROP TRIGGER IF EXISTS entries_ad;
      DROP TRIGGER IF EXISTS entries_au;
      DROP TABLE IF EXISTS entries_fts;
    `)
    // 老库（v1）没有 seg 列，补上
    const columns = db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name)
    for (const col of ["seg_title", "seg_content", "seg_tags"]) {
      if (!columns.includes(col)) {
        db.exec(`ALTER TABLE entries ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`)
      }
    }
    // 回填 seg 列（JS 侧分字，SQL 做不了）
    const rows = db.prepare(`SELECT id, title, content, tags FROM entries`).all()
    const update = db.prepare(`UPDATE entries SET seg_title = ?, seg_content = ?, seg_tags = ? WHERE id = ?`)
    for (const r of rows) {
      update.run(segmentCJK(r.title), segmentCJK(r.content), segmentCJK(r.tags), r.id)
    }

    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        seg_title, seg_content, seg_tags,
        content='entries', content_rowid='id',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, seg_title, seg_content, seg_tags)
        VALUES (new.id, new.seg_title, new.seg_content, new.seg_tags);
      END;
      CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, seg_title, seg_content, seg_tags)
        VALUES ('delete', old.id, old.seg_title, old.seg_content, old.seg_tags);
      END;
      CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, seg_title, seg_content, seg_tags)
        VALUES ('delete', old.id, old.seg_title, old.seg_content, old.seg_tags);
        INSERT INTO entries_fts(rowid, seg_title, seg_content, seg_tags)
        VALUES (new.id, new.seg_title, new.seg_content, new.seg_tags);
      END;
    `)
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
    db.exec(`PRAGMA user_version = 2`)
  }

  if (version < 3) {
    // v3：markdown 层（project/team）的 files 表 + FTS + 触发器
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        layer TEXT NOT NULL CHECK(layer IN ('project','team')),
        path TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('rule','knowledge','decision','pattern')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        embedding BLOB,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        seg_title TEXT NOT NULL DEFAULT '',
        seg_content TEXT NOT NULL DEFAULT '',
        seg_tags TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (layer, path)
      )
    `)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        seg_title, seg_content, seg_tags,
        content='files', content_rowid='rowid',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, seg_title, seg_content, seg_tags)
        VALUES (new.rowid, new.seg_title, new.seg_content, new.seg_tags);
      END;
      CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, seg_title, seg_content, seg_tags)
        VALUES ('delete', old.rowid, old.seg_title, old.seg_content, old.seg_tags);
      END;
      CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, seg_title, seg_content, seg_tags)
        VALUES ('delete', old.rowid, old.seg_title, old.seg_content, old.seg_tags);
        INSERT INTO files_fts(rowid, seg_title, seg_content, seg_tags)
        VALUES (new.rowid, new.seg_title, new.seg_content, new.seg_tags);
      END;
    `)
    db.exec(`PRAGMA user_version = 3`)
  }

  if (version < 4) {
    // v4：personal 的 entries 表加向量列（files 表在 v3 已带）；meta 表存 embedding 模型名
    const columns = db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name)
    if (!columns.includes("embedding")) {
      db.exec(`ALTER TABLE entries ADD COLUMN embedding BLOB`)
    }
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
    db.exec(`PRAGMA user_version = 4`)
  }

  if (version < 5) {
    // v5：files 表加 origin 列（项目绝对路径），防止跨项目记忆串台
    const columns = db.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name)
    if (!columns.includes("origin")) {
      db.exec(`ALTER TABLE files ADD COLUMN origin TEXT NOT NULL DEFAULT ''`)
    }
    db.exec(`PRAGMA user_version = 5`)
  }

  if (version < 6) {
    // v6：代码索引——code_chunks 表 + FTS5（与 files 表同样模式）
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        chunk_type TEXT NOT NULL CHECK(chunk_type IN ('file','symbol')),
        symbol_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        line_start INTEGER NOT NULL DEFAULT 0,
        line_end INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        seg_content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (path, line_start)
      )
    `)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
        path, symbol_name, seg_content,
        content='code_chunks', content_rowid='rowid',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER code_chunks_ai AFTER INSERT ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(rowid, path, symbol_name, seg_content)
        VALUES (new.rowid, new.path, new.symbol_name, new.seg_content);
      END;
      CREATE TRIGGER code_chunks_ad AFTER DELETE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, path, symbol_name, seg_content)
        VALUES ('delete', old.rowid, old.path, old.symbol_name, old.seg_content);
      END;
      CREATE TRIGGER code_chunks_au AFTER UPDATE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, path, symbol_name, seg_content)
        VALUES ('delete', old.rowid, old.path, old.symbol_name, old.seg_content);
        INSERT INTO code_chunks_fts(rowid, path, symbol_name, seg_content)
        VALUES (new.rowid, new.path, new.symbol_name, new.seg_content);
      END;
    `)
    db.exec(`PRAGMA user_version = 6`)
  }

  if (version < 7) {
    // v7：文档索引——doc_chunks 表 + FTS5（与 code_chunks 同模式），markdown 按 ## 标题分块
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_chunks (
        path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'markdown',
        heading TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        line_start INTEGER NOT NULL DEFAULT 0,
        line_end INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        seg_content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (path, line_start)
      )
    `)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
        path, heading, seg_content,
        content='doc_chunks', content_rowid='rowid',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(rowid, path, heading, seg_content)
        VALUES (new.rowid, new.path, new.heading, new.seg_content);
      END;
      CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, path, heading, seg_content)
        VALUES ('delete', old.rowid, old.path, old.heading, old.seg_content);
      END;
      CREATE TRIGGER doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, path, heading, seg_content)
        VALUES ('delete', old.rowid, old.path, old.heading, old.seg_content);
        INSERT INTO doc_chunks_fts(rowid, path, heading, seg_content)
        VALUES (new.rowid, new.path, new.heading, new.seg_content);
      END;
    `)
    db.exec(`PRAGMA user_version = 7`)
  }

  if (version < 8) {
    // v8：code_chunks/doc_chunks 加 origin 列（项目根目录绝对路径），主键改为 (origin, path, line_start)。
    // 旧主键不含 origin，多项目共用一个记忆库时同相对路径互相覆盖、codeSync(B) 会把 A 的块当 stale 清掉。
    // SQLite 不能 ALTER 主键，且索引是易失品 → 直接删表重建（下次 codeSync/docSync 自动重索引）。
    db.exec(`
      DROP TRIGGER IF EXISTS code_chunks_ai;
      DROP TRIGGER IF EXISTS code_chunks_ad;
      DROP TRIGGER IF EXISTS code_chunks_au;
      DROP TABLE IF EXISTS code_chunks_fts;
      DROP TABLE IF EXISTS code_chunks;
      DROP TRIGGER IF EXISTS doc_chunks_ai;
      DROP TRIGGER IF EXISTS doc_chunks_ad;
      DROP TRIGGER IF EXISTS doc_chunks_au;
      DROP TABLE IF EXISTS doc_chunks_fts;
      DROP TABLE IF EXISTS doc_chunks;
    `)
    db.exec(`
      CREATE TABLE code_chunks (
        origin TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        chunk_type TEXT NOT NULL CHECK(chunk_type IN ('file','symbol')),
        symbol_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        line_start INTEGER NOT NULL DEFAULT 0,
        line_end INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        seg_content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (origin, path, line_start)
      )
    `)
    db.exec(`
      CREATE VIRTUAL TABLE code_chunks_fts USING fts5(
        path, symbol_name, seg_content,
        content='code_chunks', content_rowid='rowid',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER code_chunks_ai AFTER INSERT ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(rowid, path, symbol_name, seg_content)
        VALUES (new.rowid, new.path, new.symbol_name, new.seg_content);
      END;
      CREATE TRIGGER code_chunks_ad AFTER DELETE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, path, symbol_name, seg_content)
        VALUES ('delete', old.rowid, old.path, old.symbol_name, old.seg_content);
      END;
      CREATE TRIGGER code_chunks_au AFTER UPDATE ON code_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, path, symbol_name, seg_content)
        VALUES ('delete', old.rowid, old.path, old.symbol_name, old.seg_content);
        INSERT INTO code_chunks_fts(rowid, path, symbol_name, seg_content)
        VALUES (new.rowid, new.path, new.symbol_name, new.seg_content);
      END;
    `)
    db.exec(`
      CREATE TABLE doc_chunks (
        origin TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'markdown',
        heading TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        line_start INTEGER NOT NULL DEFAULT 0,
        line_end INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        seg_content TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (origin, path, line_start)
      )
    `)
    db.exec(`
      CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(
        path, heading, seg_content,
        content='doc_chunks', content_rowid='rowid',
        tokenize='unicode61'
      )
    `)
    db.exec(`
      CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(rowid, path, heading, seg_content)
        VALUES (new.rowid, new.path, new.heading, new.seg_content);
      END;
      CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, path, heading, seg_content)
        VALUES ('delete', old.rowid, old.path, old.heading, old.seg_content);
      END;
      CREATE TRIGGER doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, path, heading, seg_content)
        VALUES ('delete', old.rowid, old.path, old.heading, old.seg_content);
        INSERT INTO doc_chunks_fts(rowid, path, heading, seg_content)
        VALUES (new.rowid, new.path, new.heading, new.seg_content);
      END;
    `)
    db.exec(`PRAGMA user_version = 8`)
  }
  db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

/**
 * CJK 逐字加空格：让 unicode61 把每个汉字/日韩字当独立 token。
 * 写入和查询必须使用同一处理，检索才能对上。
 */
function segmentCJK(text) {
  return text.replace(
    /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g,
    (run) => [...run].join(" "),
  )
}

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
      return entry ? { ...entry, rrf: score } : null // fetchEntry 为 null 时不能展开（会漏出 { rrf } 空壳）
    })
    .filter(Boolean)
}

/** 纯 FTS 检索（两表合并，按 bm25 排序），RRF 的位置输入 */
function ftsSearch(memory, ftsQuery, limit) {
  const personal = memory.db.prepare(`
    SELECT e.id, e.type, e.title, e.content, e.tags, bm25(entries_fts) AS rank
    FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
    WHERE entries_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, limit).map((r) => ({ ...r, layer: "personal", id: `personal:${r.id}` }))

  // projectOrigin 设置时只返回本项目的 project 条目（team 层不过滤）；未设置时（全局 CLI）不过滤
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
function fetchEntry(memory, uid) {
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
async function ensureEmbeddings(memory) {
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
    await ensureCodeEmbeddings(memory)
    await ensureDocEmbeddings(memory)
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
  await ensureCodeEmbeddings(memory)
  await ensureDocEmbeddings(memory)
}

/**
 * 写入一条 markdown 记忆到指定层目录（project/team），并即时索引。
 * 只写文件——project 层绝不替用户的项目仓库做 git 操作；
 * team 层的 commit+push 由 gitmem.mjs 负责（M8）。
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
 * 返回 { added, updated, removed }
 */
export async function syncDir(memory, { layer, dir }) {
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
  } catch {
    names = [] // 目录不存在 = 这层没内容
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
      skipped++ // 无 frontmatter 的非条目文件（README 等）跳过，不入索引
      indexed.delete(filename)
      continue
    }
    if (isNew) added++
    else updated++
    indexed.delete(filename)
  }

  // 索引里剩下的是磁盘上已消失的
  let removed = 0
  for (const stale of indexed.keys()) {
    memory.db.prepare(`DELETE FROM files WHERE layer = ? AND path = ?`).run(layer, stale)
    removed++
  }
  return { added, updated, removed, skipped }
}

/** 解析单个 .md 并 upsert 进 files 表 */
async function indexMarkdownFile(memory, { layer, dir, filename, mtimeMs }) {
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
function buildFtsQuery(query) {
  const terms = segmentCJK(query)
    .split(/[\s,，。、;；!！?？()（）"`]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16)
  if (terms.length === 0) return ""
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ")
}

// ========== 代码索引 ==========

/** 推断文件语言（按扩展名） */
function detectLanguage(filename) {
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
 * 不解析 AST——够识别 "在哪里定义了什么" 就够用。
 */
function extractSymbols(lines, ext) {
  const jsish = new Set([".mjs", ".js", ".ts", ".jsx", ".tsx"])
  if (!jsish.has(ext)) return []

  const symbols = []
  const text = lines.join("\n")
  // 顶层 export/函数/类（不在注释内的简化匹配）
  const re = /(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|class\s+(\w+)|(?:export\s+)?(?:const|let|var)\s+(\w+))/gm
  let m
  while ((m = re.exec(text))) {
    const name = m[1] || m[2] || m[3]
    if (!name || name[0] !== name[0].toLowerCase() && name.length < 2) continue // 跳过全大写常量（噪声）
    const line = text.slice(0, m.index).split("\n").length
    symbols.push({ name, line, kind: m[1] ? "function" : m[2] ? "class" : "variable" })
  }
  return symbols
}

/**
 * 提取 Python 文件的顶层 def/class。
 */
function extractPySymbols(lines) {
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
function chunkCode(lines, filepath) {
  const ext = filepath.slice(filepath.lastIndexOf(".")).toLowerCase()
  const chunks = []

  if (lines.length <= BIG_FILE_LINES) {
    // 小文件：整文件一块；提取文件头注释作为前缀
    const doc = extractLeadingDoc(lines, 1, ext)
    const content = (doc ? doc + "\n" : "") + lines.join("\n").trimEnd()
    chunks.push({ name: filepath, line_start: 1, line_end: lines.length, content })
    return chunks
  }

  // 大文件：按符号切分
  const symbols = ext === ".py" ? extractPySymbols(lines) : extractSymbols(lines, ext)
  if (symbols.length <= 1) {
    const doc = extractLeadingDoc(lines, 1, ext)
    const content = (doc ? doc + "\n" : "") + lines.join("\n").trimEnd()
    chunks.push({ name: filepath, line_start: 1, line_end: lines.length, content })
    return chunks
  }

  // 符号间切分：每个符号从自己的行开始到下一个符号前一行结束
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
 * 没有则返回空字符串。
 */
function extractLeadingDoc(lines, lineNum, ext) {
  if (ext === ".py") {
    // Python: docstring 在 def/class 的下一行
    if (lineNum >= lines.length) return ""
    const next = lines[lineNum] // lineNum 是 1-based，下一行 index = lineNum
    const m = next?.match(/^\s*"""(.+?)"""\s*$/)
    if (m) return m[1].trim()
    // 多行 docstring
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

  // JS/TS: 向前扫描 /** ... *​/ 或连续 // 行
  const jsish = new Set([".mjs", ".js", ".ts", ".jsx", ".tsx"])
  if (!jsish.has(ext)) return ""

  const parts = []
  let i = lineNum - 2 // lineNum 是 1-based，前一行 index = lineNum-2
  // 先看紧邻的 JSDoc 块
  if (i >= 0 && /^\s*\*\/\s*$/.test(lines[i])) {
    // 找到 JSDoc 结尾，反向找开头
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
    // 收集连续 // 注释行
    while (i >= 0 && /^\s*\/\//.test(lines[i])) {
      parts.unshift(lines[i].replace(/^\s*\/\/\s*/, "").trim())
      i--
    }
  }

  const text = parts.join(" ").trim()
  return text.length > 0 && text.length < 300 ? text : ""
}

/** 单文件入索引：删除旧块 → 分块 → 插入新块（codeSync 和 reindexFile 共用） */
/** 将控制权交还给事件循环一个 tick（让键盘输入有机会被处理） */
function yieldTick() {
  return new Promise((r) => setTimeout(r, 0))
}

function _upsertCodeFile(memory, origin, rel, lines, lang, mtimeMs) {
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

function _upsertDocFile(memory, origin, rel, lines, mtimeMs) {
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

/**
 * git 驱动增量索引：用 git diff 找出上次索引以来的变更文件，
 * 只重建这些文件的 FTS5 块（不碰向量）。比全量 mtime 扫描快一个数量级。
 * 返回 { updated, removed, skipped } 或 null（git 不可用时，调用方退到 codeSync）。
 */
export async function gitSync(memory, dir, { onProgress } = {}) {
  const { execSync } = await import("node:child_process")
  const opts = { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }

  let head
  try { head = execSync("git rev-parse HEAD", opts).trim() } catch { return null }

  const stored = memory.db.prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`).get()?.value
  if (!stored) return null // 首次运行，走全量 codeSync

  // 取两个 diff 的并集：已提交的变更（pull/merge）+ 工作区脏文件（用户在外部编辑器改的）
  let diffOut
  try {
    // --diff-filter 只取增/改/重命名，不取删（删文件由 reindexFile 自己检测）
    const committed = execSync(`git diff --name-only --diff-filter=ACMRT ${stored} HEAD`, opts).trim()
    const dirty = execSync(`git diff --name-only --diff-filter=ACMRT`, opts).trim()
    const lines = [...new Set([...committed.split("\n").filter(Boolean), ...dirty.split("\n").filter(Boolean)])]
    diffOut = lines
  } catch {
    // rebase / shallow clone 导致旧 commit 不可达 → 退到全量
    return null
  }

  if (diffOut.length > 200) {
    // 大范围变更（分支切换等）→ 退到 codeSync，它有更好的进度反馈
    return null
  }

  let updated = 0, removed = 0, skipped = 0
  for (let i = 0; i < diffOut.length; i++) {
    const rel = diffOut[i].replaceAll("\\", "/")
    const abs = join(dir, rel)
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase()

    // 跳过隐藏目录和 SKIP_DIRS 里的文件
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
      // 文件已被删 → 清理索引
      if (CODE_EXTS.has(ext)) memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(dir, rel)
      else memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(dir, rel)
      removed++
    }
    if (onProgress && i % 5 === 0) {
      onProgress({ phase: "index", current: i + 1, total: diffOut.length, updated, removed, skipped })
    }
  }

  // 更新锚点
  memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_indexed_commit', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(head)

  onProgress?.({ phase: "done", total: diffOut.length, updated, removed, skipped })
  return { updated, removed, skipped }
}

/**
 * 同步代码索引：扫描 dir 下所有源文件 → 分块 → upsert 到 code_chunks。
 * 按 mtime 增量——只重建变更过的文件块。
 * onProgress({ phase, current, total }) 可选回调，用于 UI 进度展示。
 */
export async function codeSync(memory, dir, { onProgress } = {}) {
  // 收集所有源文件
  const files = []
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

  // 取已索引文件的 mtime 快照（只看本 origin，别的项目的块不归这里管）
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

    // 单文件失败不拖垮整轮同步：记下错误继续，调用方看 failed/errors
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

  // 清理磁盘上已消失的文件块（仅本 origin）
  for (const stale of indexed.keys()) {
    if (!seen.has(stale)) {
      memory.db.prepare(`DELETE FROM code_chunks WHERE origin = ? AND path = ?`).run(dir, stale)
      removed++
    }
  }

  onProgress?.({ phase: "done", total: files.length, updated, removed, skipped, failed })
  return { updated, removed, skipped, failed, errors, total: files.length }
}

/**
 * 代码检索：FTS5(BM25) + 可选向量余弦，RRF 合并。
 * 无 embedder 时退化为纯 FTS；ftsQuery 为空（纯标点查询）且有 embedder 时退化为纯向量。
 * 返回 [{ path, language, symbol_name, content, line_start, line_end }]
 */
export async function codeSearch(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery && !memory.embedder) return []

  // codeOrigin 设置时只检索本项目（与 files 表的 projectOrigin 过滤同模式）；未设置时不过滤
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

  // 向量通道
  await ensureEmbeddings(memory)
  const [qvec] = await embed(memory.embedder, [query])
  const rows = memory.db.prepare(`SELECT rowid, embedding FROM code_chunks WHERE embedding IS NOT NULL ${vecOriginFilter}`).all(...originParams)
  const vecList = rows
    .map((r) => ({ rowid: r.rowid, score: cosine(qvec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 20))

  // RRF 合并（按 rowid 对齐两个通道；解析结果回表取，纯向量命中的块也能浮现）
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
async function ensureCodeEmbeddings(memory) {
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

/**
 * 生成 code_search 工具（只读，与 memory_search 同模式）。
 */
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
 * 不影响其他文件（比全量 codeSync/docSync 快几个数量级）。
 */
export async function reindexFile(memory, cwd, absPath) {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase()
  const rel = relative(cwd, absPath).replaceAll("\\", "/")
  // 越界路径拒索引：必须是 ".." 或 "../..." 才算越界——文件名以 .. 开头（如 ..foo.js）不算
  if (rel === ".." || rel.startsWith("../")) return
  // 与 walk 策略一致：跳过隐藏目录和 SKIP_DIRS 里的文件（node_modules/.git/dist…），
  // 否则这些文件虽然全量扫描时被跳过，单文件增量更新却会漏进来
  const dirs = rel.split("/").slice(0, -1)
  if (dirs.some((d) => SKIP_DIRS.has(d) || d.startsWith("."))) return

  let text
  try { text = await readFile(absPath, "utf8") } catch {
    // 文件已删：清理索引
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
  // 立即补算向量，不等惰性检索（刚改的文件应该有语义搜索能力）
  if (memory.embedder) {
    try { await ensureEmbeddings(memory) } catch { /* embedding 失败不阻塞 */ }
  }
}

// ========== 文档索引 ==========

/**
 * 按 ## 标题切分 markdown 文件。每个 ## section 独立入索引，
 * 标题路径做 heading（如 "README.md > 部署 > Docker"），方便检索定位。
 */
function chunkMarkdown(lines, filepath) {
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
  // tail
  if (start <= lines.length) {
    chunks.push({ heading, line_start: start, line_end: lines.length, content: lines.slice(start - 1).join("\n").trimEnd() })
  }
  return chunks.filter((c) => c.content)
}

/**
 * 同步文档索引：扫描 dir 下所有 .md/.mdc/.txt/.rst/.adoc → 分块 → upsert 到 doc_chunks。
 * 按 mtime 增量。
 */
export async function docSync(memory, dir, { onProgress } = {}) {
  const files = []
  async function walk(d) {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        await walk(join(d, e.name))
      } else if (e.isFile()) {
        const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase()
        if (DOC_EXTS.has(ext)) files.push(join(d, e.name))
      }
    }
  }
  await walk(dir)

  const indexed = new Map(
    memory.db.prepare(`SELECT path, mtime_ms FROM doc_chunks WHERE origin = ?`).all(dir).map((r) => [r.path, r.mtime_ms])
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

    // 单文件失败不拖垮整轮同步（与 codeSync 同策略）
    try {
      const text = await readFile(abs, "utf8")
      const lines = text.split("\n")
      _upsertDocFile(memory, dir, rel, lines, mtimeMs)
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

  // 清理磁盘上消失的文件（仅本 origin）
  for (const stale of indexed.keys()) {
    if (!seen.has(stale)) {
      memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(dir, stale)
      removed++
    }
  }

  onProgress?.({ phase: "done", total: files.length, updated, removed, skipped, failed })
  return { updated, removed, skipped, failed, errors, total: files.length }
}

/**
 * 文档检索：FTS5(BM25) + 可选向量余弦，RRF 合并。
 * 无 embedder 时退化为纯 FTS；ftsQuery 为空（纯标点查询）且有 embedder 时退化为纯向量。
 * 返回 [{ path, language, heading, content, line_start, line_end }]
 */
export async function docSearch(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery && !memory.embedder) return []

  // codeOrigin 设置时只检索本项目（与 codeSearch 同模式）；未设置时不过滤
  const ftsOriginFilter = memory.codeOrigin ? `AND d.origin = ?` : ""
  const vecOriginFilter = memory.codeOrigin ? `AND origin = ?` : ""
  const originParams = memory.codeOrigin ? [memory.codeOrigin] : []

  const ftsList = ftsQuery ? memory.db.prepare(`
    SELECT d.rowid, d.path, d.language, d.heading, d.content, d.line_start, d.line_end, bm25(doc_chunks_fts) AS rank
    FROM doc_chunks_fts JOIN doc_chunks d ON d.rowid = doc_chunks_fts.rowid
    WHERE doc_chunks_fts MATCH ? ${ftsOriginFilter}
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, ...originParams, Math.max(limit * 4, 20)) : []

  if (!memory.embedder) return ftsList.slice(0, limit)

  // 向量通道
  await ensureDocEmbeddings(memory)
  const [qvec] = await embed(memory.embedder, [query])
  const rows = memory.db.prepare(`SELECT rowid, embedding FROM doc_chunks WHERE embedding IS NOT NULL ${vecOriginFilter}`).all(...originParams)
  const vecList = rows
    .map((r) => ({ rowid: r.rowid, score: cosine(qvec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 20))

  // RRF 合并（按 rowid 对齐两个通道；解析结果回表取，纯向量命中的块也能浮现）
  const K = 60
  const scores = new Map()
  ftsList.forEach((r, i) => scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1 / (K + i + 1)))
  vecList.forEach((r, i) => scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1 / (K + i + 1)))

  const fetchChunk = memory.db.prepare(`
    SELECT path, language, heading, content, line_start, line_end FROM doc_chunks WHERE rowid = ?
  `)
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rowid]) => fetchChunk.get(rowid))
    .filter(Boolean)
}

/** 惰性补算 doc_chunks 缺失的向量 */
async function ensureDocEmbeddings(memory) {
  if (!memory.embedder) return
  const modelKey = memory.embedder.model
  const stored = memory.db.prepare(`SELECT value FROM meta WHERE key = 'doc_embedding_model'`).get()?.value
  if (stored !== modelKey) {
    memory.db.prepare(`UPDATE doc_chunks SET embedding = NULL`).run()
    memory.db.prepare(`INSERT INTO meta (key, value) VALUES ('doc_embedding_model', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(modelKey)
  }

  const pending = memory.db.prepare(`SELECT rowid, path, heading, content FROM doc_chunks WHERE embedding IS NULL LIMIT 64`).all()
  if (pending.length === 0) return

  const texts = pending.map((r) => `${r.heading || r.path}\n${r.content.slice(0, 2000)}`)
  const vecs = await embed(memory.embedder, texts)

  const update = memory.db.prepare(`UPDATE doc_chunks SET embedding = ? WHERE rowid = ?`)
  pending.forEach((r, i) => update.run(toBlob(vecs[i]), r.rowid))
}

/**
 * 生成 doc_search 工具（只读）。
 */
export function docSearchTool(memory) {
  return {
    name: "doc_search",
    description:
      "Search the project's documentation (README, design docs, guides, markdown files) for relevant information. Use this to find design decisions, coding conventions, architecture docs, or project rules. Prefer this over code_search when you need to understand the project's intended design rather than existing implementation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    readonly: true,
    async execute(args) {
      const results = await docSearch(memory, args.query, { limit: args.limit ?? 5 })
      if (results.length === 0) return "(no matching documentation)"
      return results.map((r) =>
        `${r.path}${r.heading ? ` > ${r.heading}` : ""} (L${r.line_start}-L${r.line_end}):\n${r.content.slice(0, 2000)}`
      ).join("\n\n---\n\n")
    },
  }
}

// ---------------------------------------------------------------- agent 工具

/**
 * 生成记忆相关的两个 agent 工具（遵循 tools.mjs 的工具形状）。
 * memory_put 是有副作用工具（需权限确认），memory_search 只读。
 * opts: { cwd, projectDir, author, team: { dir, name } | null }
 */
export function memoryTools(memory, opts = {}) {
  const projectDir = opts.projectDir ? join(opts.cwd ?? process.cwd(), opts.projectDir) : null
  return [
    {
      name: "memory_put",
      description:
        "Save a piece of knowledge to long-term memory. Use when you learn something worth remembering across sessions: a project convention, a debugging insight, an architecture decision. Types: rule (coding standards), knowledge (project facts), decision (architecture decisions), pattern (debugging/workflow patterns). Scopes: personal (default, private to you), project (shared via this repo's .thincoder/memory/), team (org-wide team repo, if configured).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["rule", "knowledge", "decision", "pattern"] },
          title: { type: "string", description: "Short title" },
          content: { type: "string", description: "Full content to remember" },
          tags: { type: "string", description: "Space-separated tags" },
          scope: { type: "string", enum: ["personal", "project", "team"], description: "Where to save (default personal)" },
        },
        required: ["type", "title", "content"],
      },
      readonly: false,
      async execute(args) {
        const scope = args.scope ?? "personal"
        if (scope === "personal") {
          const id = await put(memory, args)
          return `Saved to personal memory (id=${id}): [${args.type}] ${args.title}`
        }
        if (scope === "project") {
          if (!projectDir) throw new Error("project scope unavailable: no project directory configured")
          const filename = await putMarkdown(memory, {
            layer: "project",
            dir: projectDir,
            type: args.type,
            title: args.title,
            content: args.content,
            tags: (args.tags ?? "").split(/\s+/).filter(Boolean),
            author: opts.author ?? "unknown",
          })
          return `Saved to project memory (${filename}): [${args.type}] ${args.title}\nNote: file written to the repo; commit it yourself when ready.`
        }
        // team：写文件 + 索引 + commit + push（team 仓库是 ThinCoder 自管设施，可以自动提交）
        if (!opts.team?.dir) {
          throw new Error("team scope not configured: set memory.team in ~/.thincoder/config.json")
        }
        const filename = await putMarkdown(memory, {
          layer: "team",
          dir: opts.team.dir,
          type: args.type,
          title: args.title,
          content: args.content,
          tags: (args.tags ?? "").split(/\s+/).filter(Boolean),
          author: opts.author ?? "unknown",
        })
        await commitAndPush(opts.team.dir, filename, `memory: [${args.type}] ${args.title}`)
        return `Saved to team memory and pushed (${filename}): [${args.type}] ${args.title}`
      },
    },
    {
      name: "memory_search",
      description:
        "Search long-term memory across all layers (personal/project/team) for relevant knowledge saved in previous sessions. Use the same language as the memories being searched.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
      readonly: true,
      async execute(args) {
        const results = await search(memory, args.query, { limit: args.limit ?? 5 })
        if (results.length === 0) return "(no matching memories)"
        return results.map((r) => `[${r.layer}][${r.type}] ${r.title}\n${r.content}`).join("\n\n")
      },
    },
  ]
}
