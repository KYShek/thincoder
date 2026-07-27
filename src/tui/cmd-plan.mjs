import { ansi, C } from "./ansi.mjs"

/** /plan 命令：切换 plan mode（只读探索 → 设计 → 实现）。
 *  ctx: { agent, pushLine, pushLabel } */
export async function handlePlanCommand(ctx) {
  const { agent, pushLine, pushLabel } = ctx
  agent.planMode = !agent.planMode
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.planMode) {
    agent._pendingReminders.push("[System reminder: plan mode is now ON. You are restricted to READ-ONLY tools — explore, search, read, analyze. DO NOT write, edit, or run mutation commands. Present your design to the user first.]")
  } else {
    agent._pendingReminders.push("[System reminder: plan mode is now OFF. You may edit files, run commands, and implement changes.]")
  }
  pushLabel(`❯ Plan`, ansi.bold + (agent.planMode ? C.tool : C.dim))
  pushLine(
    agent.planMode
      ? `Plan mode ON: read-only tools only. Design first, then implement. /plan again to exit.`
      : `Plan mode OFF: you may now edit files and run commands.`,
    agent.planMode ? C.tool : C.dim,
  )
}
