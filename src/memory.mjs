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
import { dirname } from "node:path"

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])
const SCHEMA_VERSION = 2

/**
 * 打开/初始化记忆库。dbPath 不存在会自动创建。
 * 返回的 memory 对象即接口，后续函数的第一个参数都是它。
 */
export function createMemory({ dbPath }) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)

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

/** 按 user_version 逐步迁移 */
function migrate(db) {
  const { user_version: version } = db.prepare(`PRAGMA user_version`).get()
  if (version >= SCHEMA_VERSION) return

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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
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
 * FTS5 全文检索，BM25 排序，OR 语义（一词命中即可，相关度排序）。
 * 返回 [{ id, type, title, content, tags, rank }]
 */
export async function search(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return []
  const stmt = memory.db.prepare(`
    SELECT e.id, e.type, e.title, e.content, e.tags, bm25(entries_fts) AS rank
    FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
    WHERE entries_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `)
  return stmt.all(ftsQuery, limit)
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
    .split(/[\s,，。、;；!！?？()（）"'`]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16)
  if (terms.length === 0) return ""
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ")
}

// ---------------------------------------------------------------- agent 工具

/**
 * 生成记忆相关的两个 agent 工具（遵循 tools.mjs 的工具形状）。
 * memory_put 是有副作用工具（需权限确认），memory_search 只读。
 */
export function memoryTools(memory) {
  return [
    {
      name: "memory_put",
      description:
        "Save a piece of knowledge to long-term memory. Use when you learn something worth remembering across sessions: a project convention, a debugging insight, an architecture decision. Types: rule (coding standards), knowledge (project facts), decision (architecture decisions), pattern (debugging/workflow patterns).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["rule", "knowledge", "decision", "pattern"] },
          title: { type: "string", description: "Short title" },
          content: { type: "string", description: "Full content to remember" },
          tags: { type: "string", description: "Space-separated tags" },
        },
        required: ["type", "title", "content"],
      },
      readonly: false,
      async execute(args) {
        const id = await put(memory, args)
        return `Saved to memory (id=${id}): [${args.type}] ${args.title}`
      },
    },
    {
      name: "memory_search",
      description:
        "Search long-term memory for relevant knowledge saved in previous sessions. Query in the same language as the memories (Chinese memories need Chinese queries).",
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
        return results.map((r) => `[${r.type}] #${r.id} ${r.title}\n${r.content}`).join("\n\n")
      },
    },
  ]
}
