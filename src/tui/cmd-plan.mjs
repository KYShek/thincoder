/** /plan command: toggle plan mode (read-only explore → design → implement).
 *  ctx: { agent, pushLine, pushLabel } */
import { ansi, C } from "./ansi.mjs"

export async function handlePlanCommand(ctx) {
  const { agent, pushLine, pushLabel } = ctx
  agent.planMode = !agent.planMode
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.planMode) {
    agent._pendingReminders.push("[System reminder: plan mode is now ON. You are restricted to READ-ONLY tools — explore, search, read, analyze. DO NOT write, edit, or run mutation commands. Present your design to the user first.]")
  } else {
    agent._pendingReminders.push("[System reminder: plan mode is now OFF. You may edit files, run commands, and implement changes.]")
  }
  pushLabel("❯ Plan", ansi.bold + C.tool)
  pushLine(`Plan mode: ${agent.planMode ? "ON" : "OFF"}`, C.tool)
}
