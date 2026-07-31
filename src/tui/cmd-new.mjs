import { newSession } from "../session.mjs"
import { C } from "./ansi.mjs"

/** /new command: start a new session in a fresh slot.
 *  ctx: { agent, state, pushLine, showPicker, render } */
export async function handleNewCommand(ctx) {
  const { agent, state, pushLine, showPicker, render } = ctx

  const doNewSession = () => {
    const slot = newSession(agent.cwd)
    agent.history = []
    agent.tasks = []
    agent.planMode = false
    agent.goal = null
    agent._pendingReminders = []
    state.tasks = []
    state.lines = []
    state.streaming = ""
    render()
    pushLine(`New session started (slot ${slot}; /session to switch back)`, C.dim)
  }

  if (agent.history.length > 0) {
    const e = await showPicker("Start new session?", [
      { type: "item", text: "Yes, start new session in a new slot", action: "yes" },
      { type: "item", text: "Cancel", action: "no" },
    ], { defaultIndex: 1 })
    if (e?.action === "yes") doNewSession()
    return
  }
  doNewSession()
}
