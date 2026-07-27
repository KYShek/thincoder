/** /plan command: toggle plan mode (read-only explore → design → implement).
 *  ctx: { agent } */
export async function handlePlanCommand(ctx) {
  const { agent } = ctx
  agent.planMode = !agent.planMode
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.planMode) {
    agent._pendingReminders.push("[System reminder: plan mode is now ON. You are restricted to READ-ONLY tools — explore, search, read, analyze. DO NOT write, edit, or run mutation commands. Present your design to the user first.]")
  } else {
    agent._pendingReminders.push("[System reminder: plan mode is now OFF. You may edit files, run commands, and implement changes.]")
  }
}
