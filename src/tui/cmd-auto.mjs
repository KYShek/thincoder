import { ansi, C } from "./ansi.mjs"

/** /auto 命令：切换 auto-approve 模式。
 *  ctx: { agent, pushLine, pushLabel } */
export async function handleAutoCommand(ctx) {
  const { agent, pushLine, pushLabel } = ctx
  agent.autoApprove = !agent.autoApprove
  agent._pendingReminders = agent._pendingReminders ?? []
  if (agent.autoApprove) {
    agent._pendingReminders.push("[System reminder: AUTO mode is now ON. All tool calls are automatically approved — you may write, edit, and run commands without asking. Use this for long autonomous tasks. The user can still interrupt.]")
  } else {
    agent._pendingReminders.push("[System reminder: AUTO mode is now OFF. Destructive tool calls now require user approval again. Confirm before writing files, running commands, or spawning subagents.]")
  }
  pushLabel(`❯ Auto`, ansi.bold + (agent.autoApprove ? C.warn : C.tool))
  pushLine(
    agent.autoApprove
      ? `AUTO ON: all tool calls (write/bash/subagent) auto-approved. For long tasks. /auto to disable.`
      : `AUTO OFF: destructive tool calls require per-use approval again.`,
    agent.autoApprove ? C.warn : C.dim,
  )
}
