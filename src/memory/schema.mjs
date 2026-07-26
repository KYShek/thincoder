/**
 * memory/schema.mjs — 数据库 schema 定义、迁移、CJK 分词
 * v1：node:sqlite + FTS5 单机实现，零依赖。
 *
 * 中文检索方案：FTS5 unicode61 分词 + CJK 逐字加空格（写入和查询两侧同样处理）。
 * 效果：中文按字索引，"分号" 这类双字词也能命中；ASCII 仍按整词。
 */

import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])
export const SCHEMA_VERSION = 8

// 代码索引：源码文件扩展名
export const CODE_EXTS = new Set([".mjs", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".swift", ".kt", ".sh", ".bash", ".sql", ".yaml", ".yml", ".toml", ".json", ".css", ".html", ".vue", ".svelte"])
// 文档索引：markdown / 纯文本（分开索引，便于 LLM 区分"设计规范"和"现存代码"）
export const DOC_EXTS = new Set([".md", ".mdc", ".txt", ".rst", ".adoc"])
// 总是跳过的目录名
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "coverage", "__pycache__", ".venv", "venv", "target", ".next", ".nuxt", ".svelte-kit"])
// 大文件阈值（行数）：超过此行数按符号分块，否则整文件入索引
export const BIG_FILE_LINES = 2000

/**
 * CJK 逐字加空格：让 unicode61 把每个汉字/日韩字当独立 token。
 * 写入和查询必须使用同一处理，检索才能对上。
 */
export function segmentCJK(text) {
  return text.replace(
    /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g,
    (run) => [...run].join(" "),
  )
}

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
export function migrate(db) {
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
    // SQLite 不能 ALTER 主键 → 直接删表重建（下次 codeSync/docSync 自动重索引）。
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
