/**
 * markdown.mjs — 记忆条目的 markdown + frontmatter 格式
 * 零依赖解析/序列化。条目格式见 ARCHITECTURE-v2.md。
 */

const VALID_TYPES = new Set(["rule", "knowledge", "decision", "pattern"])

/**
 * 解析 markdown 条目。
 * → { meta: { type, title, tags, author, created, embedding? }, content }
 * 无 frontmatter 或缺必要字段时抛错。
 */
export function parseEntry(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error("entry missing frontmatter (expected --- ... ---)")

  const meta = parseFrontmatter(match[1])
  const content = match[2].trim()

  if (!VALID_TYPES.has(meta.type)) {
    throw new Error(`invalid type "${meta.type}"; expected one of: ${[...VALID_TYPES].join(", ")}`)
  }
  if (!meta.title) throw new Error("frontmatter missing required field: title")

  return {
    meta: {
      type: meta.type,
      title: meta.title,
      tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
      author: meta.author ?? "unknown",
      created: meta.created ?? "",
      ...(meta.embedding ? { embedding: meta.embedding } : {}),
    },
    content,
  }
}

/**
 * 序列化为 markdown 条目文本。
 */
export function serializeEntry(meta, content) {
  if (!VALID_TYPES.has(meta.type)) throw new Error(`invalid type "${meta.type}"`)
  if (!meta.title) throw new Error("meta.title is required")
  const tags = (meta.tags ?? []).map((t) => `${t}`).join(", ")
  const lines = [
    "---",
    `type: ${meta.type}`,
    `title: ${meta.title}`,
    `tags: [${tags}]`,
    `author: ${meta.author ?? "unknown"}`,
    `created: ${meta.created ?? new Date().toISOString().slice(0, 10)}`,
  ]
  if (meta.embedding) lines.push(`embedding: ${meta.embedding}`)
  lines.push("---", "", content.trim(), "")
  return lines.join("\n")
}

/** 标题转文件名 slug：保留中英文数字，其余转连字符 */
export function slugify(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "untitled"
}

/** 生成条目文件名：YYYYMMDD-<slug>-<rand4>.md */
export function entryFilename(title, date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replaceAll("-", "")
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ymd}-${slugify(title)}-${rand}.md`
}

// ---------------------------------------------------------------- 内部

/**
 * 极简 YAML 子集解析：只支持 `key: value` 和 `key: [a, b, c]`。
 * 我们的 frontmatter 是自己生成的，不需要完整 YAML。
 */
function parseFrontmatter(text) {
  const meta = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const value = raw.trim()
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      meta[key] = value
    }
  }
  return meta
}
