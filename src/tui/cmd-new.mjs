import { clearSession } from "../session.mjs"
import { C } from "./ansi.mjs"

/** /new 命令：新建会话（旧会话归档到槽位）。
 *  ctx: { agent, state, pushLine } */
export async function handleNewCommand(ctx) {
  const { agent, state, pushLine } = ctx
  agent.history = []
  agent.tasks = []
  agent.planMode = false
  agent.goal = null
  agent._pendingReminders = []
  state.tasks = []
  state.lines = []
  state.streaming = ""
  clearSession(agent.cwd)
  pushLine("New session started (old session archived to slot; /session to view)", C.dim)
}
