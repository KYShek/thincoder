import { clearSession } from "../session.mjs"
import { C } from "./ansi.mjs"

/** /new command: start new session (old session archived to slot).
 *  ctx: { agent, state, pushLine, showPicker, render } */
export async function handleNewCommand(ctx) {
  const { agent, state, pushLine, showPicker, render } = ctx

  const doNewSession = () => {
    agent.history = []
    agent.tasks = []
    agent.planMode = false
    agent.goal = null
    agent._pendingReminders = []
    state.tasks = []
    state.lines = []
    state.streaming = ""
    clearSession(agent.cwd)
    render()
    pushLine("New session started (old session archived to slot; /session to view)", C.dim)
  }

  if (agent.history.length > 0) {
    const e = await showPicker("Start new session?", [
      { type: "item", text: "Yes, archive current and start new", action: "yes" },
      { type: "item", text: "Cancel", action: "no" },
    ], { defaultIndex: 1 })
    if (e?.action === "yes") doNewSession()
    return
  }
  doNewSession()
}
