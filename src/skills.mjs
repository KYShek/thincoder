/**
 * skills.mjs — skill system
 * Discovers .md skill files AND subdirectory SKILL.md from .thincoder/skills/ directory,
 * injects into system prompt for agent to load on demand.
 * Use the skill tool to activate a specific skill; content is written into conversation history wrapped in <skill-loaded>.
 *
 * Supported formats:
 *   .thincoder/skills/my-skill.md           (flat, name = "my-skill")
 *   .thincoder/skills/my-skill/SKILL.md     (subdirectory, name = "my-skill")
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/** Valid skill name pattern (alphanumeric + hyphens/underscores) */
const NAME_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Try to read a skill from a path, return { name, path, description } or null.
 */
async function tryReadSkill(dir, name, filePath) {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return null
    const head = await readFile(filePath, "utf8")
    const body = head.slice(0, 400).split("\n")
    let desc = ""
    let inFrontmatter = false
    for (const line of body) {
      const t = line.trim()
      if (t === "---") { inFrontmatter = !inFrontmatter; continue }
      if (inFrontmatter) continue
      if (t && !t.startsWith("#")) {
        desc = t.slice(0, 120)
        break
      }
    }
    return { name, path: filePath, description: desc || "(no description)" }
  } catch {
    return null
  }
}

/**
 * Scan .thincoder/skills/ directory, return skill list.
 * Supports flat .md files and subdirectories with SKILL.md inside.
 * Each skill: { name, path, description } — name derived from filename or directory.
 * Returns empty array if directory is missing or empty.
 */
export async function loadSkills(cwd) {
  const dir = join(cwd, ".thincoder", "skills")
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  const added = new Set()

  // Pass 1: subdirectories (higher priority — standard convention)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!NAME_RE.test(entry.name)) continue
    const skill = await tryReadSkill(dir, entry.name, join(dir, entry.name, "SKILL.md"))
    if (skill) { skills.push(skill); added.add(entry.name) }
  }

  // Pass 2: flat .md files (backward compat; skipped if subdirectory with same name exists)
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const m = entry.name.match(/^([a-zA-Z0-9_-]+)\.md$/)
    if (!m) continue
    const name = m[1]
    if (added.has(name)) continue
    const skill = await tryReadSkill(dir, name, join(dir, entry.name))
    if (skill) { skills.push(skill); added.add(name) }
  }
  return skills
}

/**
 * Generate skill listing text for system prompt injection.
 * At most 3 (small footprint); overflow marked "... and N more".
 * Prefixed with DISREGARD: when listing refreshes (skills added/removed), old listings are auto-invalidated without needing to delete history (inspired by kimi-code).
 */
export function formatSkillListing(skills) {
  if (skills.length === 0) return ""
  const listed = skills.slice(0, 3)
  const lines = listed.map((s) => `- **${s.name}**: ${s.description}`)
  if (skills.length > 3) lines.push(`  ... and ${skills.length - 3} more`)
  return "DISREGARD any earlier skill listings. Current available skills (use the skill tool to load one):\n" + lines.join("\n")
}

/**
 * Read the full content of a specific skill file.
 * Tries subdirectory format (name/SKILL.md) first, then flat format (name.md).
 * Returns text, or null if not found.
 */
export async function readSkill(cwd, name) {
  if (!NAME_RE.test(name)) return null

  // Try subdirectory format: name/SKILL.md
  try {
    const p = join(cwd, ".thincoder", "skills", name, "SKILL.md")
    return await readFile(p, "utf8")
  } catch { /* not found, try flat */ }

  // Fallback to flat format: name.md
  try {
    const p = join(cwd, ".thincoder", "skills", `${name}.md`)
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}
