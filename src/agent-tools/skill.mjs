import { loadSkills, formatSkillListing, readSkill } from "../skills.mjs"
import { escapeXml } from "../agent.mjs"

/**
 * skill 工具：按需加载项目技能文件（.thincoder/skills/*.md）。
 * 加载后技能内容以 <skill-loaded> 包裹写入对话，供后续参考。
 * 列出所有可用技能用 action="list"。
 */
export const skillTool = {
  name: "skill",
  description:
    "Load a project skill from .thincoder/skills/. Skills contain reusable instructions, workflows, or reference material. Use this when the user references a skill by name, or when a task matches a known skill's description. Call with action='list' to see available skills; call with action='load' and name=<skill> to activate one.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "load"], description: "'list' to see available skills, 'load' to activate one" },
      name: { type: "string", description: "Skill name (for 'load' action)" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    const skills = await loadSkills(ctx.agent.cwd)
    if (args.action === "list") {
      if (skills.length === 0) return "No project skills found in .thincoder/skills/."
      return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    }
    if (!args.name) return "Error: skill name required for 'load' action."
    // 去重：history 里已有同名 <skill-loaded> 块就直接遵循它，不重复展开（历史即账本；
    // 被压缩掉后这里自然查不到，会重新加载——正确行为）
    if (ctx.agent.history?.some((m) => typeof m.content === "string" && m.content.includes(`<skill-loaded name="${args.name}"`))) {
      return `Skill "${args.name}" is already loaded in this conversation — follow the instructions in the existing <skill-loaded> block above. Do not reload it.`
    }
    const content = await readSkill(ctx.agent.cwd, args.name)
    if (!content) {
      const available = skills.map((s) => s.name).join(", ")
      return `Error: skill "${args.name}" not found. Available: ${available || "(none)"}`
    }
    // 注入 skill 内容到 history（下一条 user 消息）
    ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
    ctx.agent._pendingReminders.push(
      `<skill-loaded name="${args.name}" source=".thincoder/skills/${args.name}.md">\n${escapeXml(content)}\n</skill-loaded>\n\nFollow the skill's instructions above for the current task.`
    )
    return `Skill "${args.name}" loaded. Instructions will appear in the next message.`
  },
}
