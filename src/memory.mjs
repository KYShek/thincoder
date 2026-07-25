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
import { dirname, join } from "node:path"
import { parseEntry, serializeEntry, entryFilename } from "./markdown.mjs"
import { embed, cosine, toBlob, fromBlob } from "./embedding.mjs"
import { commitAndPush } from "./gitmem.mjs"

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])
const SCHEMA_VERSION = 5

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
    .map(([id, score]) => ({ ...fetchEntry(memory, id), rrf: score }))
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
  if (pendingEntries.length + pendingFiles.length === 0) return

  const items = [...pendingEntries, ...pendingFiles]
  const texts = items.map((r) => `${r.title}\n${r.content.slice(0, 2000)}`)
  const vecs = await embed(memory.embedder, texts)

  const updateEntry = memory.db.prepare(`UPDATE entries SET embedding = ? WHERE id = ?`)
  pendingEntries.forEach((r, i) => updateEntry.run(toBlob(vecs[i]), r.id))
  const updateFile = memory.db.prepare(`UPDATE files SET embedding = ? WHERE rowid = ?`)
  pendingFiles.forEach((r, i) => updateFile.run(toBlob(vecs[pendingEntries.length + i]), r.rowid))
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
        "Search long-term memory across all layers (personal/project/team) for relevant knowledge saved in previous sessions. Query in the same language as the memories (Chinese memories need Chinese queries).",
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
