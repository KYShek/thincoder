/**
 * skills.mjs — 技能系统
 * 从 .thincoder/skills/ 目录发现 .md 技能文件，
 * 注入到 system prompt 供 agent 按需加载。
 * 用 skill 工具激活指定技能，内容以 <skill-loaded> 包裹写入对话历史。
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/**
 * 扫描 .thincoder/skills/ 目录，返回技能列表。
 * 每个技能：{ name, path, description } — name 取文件名（去扩展名）。
 * 目录不存在或无文件返回空数组。
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
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(name)) continue // 与 readSkill 的名字校验一致，防"列得出、读不了"
    const p = join(dir, name)
    try {
      const s = await stat(p)
      if (!s.isFile()) continue
      // 提取描述（前 400 字符里第一段非空、非标题行）；文件带 frontmatter 时整块跳过，
      // 否则会把 frontmatter 字段行（如 "name: x"）误当描述
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
      // 读失败跳过
    }
  }
  return skills
}

/**
 * 生成技能列表文本，注入 system prompt。
 * 最多 3 个（占位少），超过则标 "... and N more"。
 * 以 DISREGARD 开头：清单刷新（技能增删）后旧清单自动作废，无需删历史（借鉴 kimi-code）。
 */
export function formatSkillListing(skills) {
  if (skills.length === 0) return ""
  const listed = skills.slice(0, 3)
  const lines = listed.map((s) => `- **${s.name}**: ${s.description}`)
  if (skills.length > 3) lines.push(`  ... and ${skills.length - 3} more`)
  return "DISREGARD any earlier skill listings. Current available skills (use the skill tool to load one):\n" + lines.join("\n")
}

/**
 * 读取指定技能文件的完整内容。
 * 返回文本，找不到返回 null。
 */
export async function readSkill(cwd, name) {
  // 安全检查：技能名只能是字母数字 + 连字符/下划线
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null
  const p = join(cwd, ".thincoder", "skills", `${name}.md`)
  try {
    return await readFile(p, "utf8")
  } catch {
    return null
  }
}
