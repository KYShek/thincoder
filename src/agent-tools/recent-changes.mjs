/**
 * recent_changes 工具：列出本轮 agent 触碰过的文件（write/edit/insert_after/delete）。
 * 比 git status 更精确——只看本会话的变更，不关心 git 追踪状态。
 * 帮助模型在长任务中回顾自己改了什么。
 */
export const recentChangesTool = {
  name: "recent_changes",
  description:
    "Show files modified in this agent run (write/edit/insert_after/delete). " +
    "Use when you need to remember which files you've already touched — during long multi-file tasks, " +
    "it's easy to lose track. This is scoped to the current run, unlike git status which shows all uncommitted changes.",
  parameters: {
    type: "object",
    properties: {},
  },
  readonly: true,
  execute(args, ctx) {
    const files = ctx.agent._touchedFiles ?? []
    if (files.length === 0) return "(no files modified in this run yet)"
    const deduped = [...new Set(files)]
    return `Touched ${deduped.length} file(s) this run:\n${deduped.join("\n")}`
  },
}
