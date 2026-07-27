/** /auto command: toggle auto-approve mode.
 *  ctx: { agent } */
export async function handleAutoCommand(ctx) {
  const { agent } = ctx
  agent.autoApprove = !agent.autoApprove
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.autoApprove) {
    agent._pendingReminders.push("[System reminder: AUTO mode is now ON. All tool calls are automatically approved — you may write, edit, and run commands without asking. Use this for long autonomous tasks. The user can still interrupt.]")
  } else {
    agent._pendingReminders.push("[System reminder: AUTO mode is now OFF. Destructive tool calls now require user approval again. Confirm before writing files, running commands, or spawning subagents.]")
  }
}
