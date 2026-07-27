/**
 * skills.mjs — skill system
 * Discovers .md skill files from .thincoder/skills/ directory,
 * injects into system prompt for agent to load on demand.
 * Use the skill tool to activate a specific skill; content is written into conversation history wrapped in <skill-loaded>.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * Scan .thincoder/skills/ directory, return skill list.
 * Each skill: { name, path, description } — name is the filename (without extension).
 * Returns empty array if directory is missing or empty.
 */
export async function loadSkills(cwd) {
  const dir = join(cwd, ".thincoder", "skills")
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const skills = []
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(name)) continue // must match readSkill's name validation; prevents "listed but unreadable"
    const p = join(dir, name)
    try {
      const s = await stat(p)
      if (!s.isFile()) continue
      // Extract description (first non-empty, non-heading line in first 400 chars);
      // skip entire frontmatter block, otherwise frontmatter fields (e.g. "name: x") get mistaken for description
      const head = await readFile(p, "utf8")
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
      skills.push({ name: name.replace(/\.md$/, ""), path: p, description: desc || "(no description)" })
    } catch {
      // Read failure — skip
    }
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
 * Returns text, or null if not found.
 */
export async function readSkill(cwd, name) {
  // Safety check: skill name must be alphanumeric + hyphens/underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null
  const p = join(cwd, ".thincoder", "skills", `${name}.md`)
  try {
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}
