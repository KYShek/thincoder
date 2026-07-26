/**
 * memory/docs.mjs — 文档索引同步、检索、agent 工具生成
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { embed, cosine, toBlob, fromBlob } from "../embedding.mjs"
import { commitAndPush } from "../git/gitmem.mjs"
import { DOC_EXTS, SKIP_DIRS } from "./schema.mjs"
import { buildFtsQuery, put, search, putMarkdown } from "./core.mjs"
import { _upsertDocFile, yieldTick } from "./code-index.mjs"
import { markIndexedCommit } from "./code-sync.mjs"

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

  for (const stale of indexed.keys()) {
    if (!seen.has(stale)) {
      memory.db.prepare(`DELETE FROM doc_chunks WHERE origin = ? AND path = ?`).run(dir, stale)
      removed++
    }
  }

  onProgress?.({ phase: "done", total: files.length, updated, removed, skipped, failed })
  markIndexedCommit(memory, dir)
  return { updated, removed, skipped, failed, errors, total: files.length }
}

/**
 * 文档检索：FTS5(BM25) + 可选向量余弦，RRF 合并。
 * 无 embedder 时退化为纯 FTS；ftsQuery 为空且有 embedder 时退化为纯向量。
 */
export async function docSearch(memory, query, { limit = 5 } = {}) {
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery && !memory.embedder) return []

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

  try { await ensureDocEmbeddings(memory) } catch { return ftsList.slice(0, limit) }
  let qvec
  try { [qvec] = await embed(memory.embedder, [query]) } catch { return ftsList.slice(0, limit) }
  const rows = memory.db.prepare(`SELECT rowid, embedding FROM doc_chunks WHERE embedding IS NOT NULL ${vecOriginFilter}`).all(...originParams)
  const vecList = rows
    .map((r) => ({ rowid: r.rowid, score: cosine(qvec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit * 4, 20))

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
export async function ensureDocEmbeddings(memory) {
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

/** 生成 doc_search 工具（只读）。 */
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
