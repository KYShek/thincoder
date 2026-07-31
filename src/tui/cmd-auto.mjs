/** /auto command: toggle auto-approve mode.
 *  ctx: { agent, pushLine, pushLabel } */
import { ansi, C } from "./ansi.mjs"

export async function handleAutoCommand(ctx) {
  const { agent, pushLine, pushLabel } = ctx
  agent.autoApprove = !agent.autoApprove
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.autoApprove) {
    agent._pendingReminders.push("[System reminder: AUTO mode is now ON. All tool calls are automatically approved — you may write, edit, and run commands without asking. Use this for long autonomous tasks. The user can still interrupt.]")
  } else {
    agent._pendingReminders.push("[System reminder: AUTO mode is now OFF. Destructive tool calls now require user approval again. Confirm before writing files, running commands, or spawning subagents.]")
  }
  pushLabel("❯ Auto", ansi.bold + C.tool)
  pushLine(`Auto-approve: ${agent.autoApprove ? "ON" : "OFF"}`, C.tool)
}
