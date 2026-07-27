import { listSlots, switchToSlot, applySession } from "../session.mjs"
import { ansi, C } from "./ansi.mjs"

/** /session command: list/switch archived session slots.
 *  ctx: { agent, state, openPicker, pushLine, pushLabel, render } */
export async function handleSessionCommand(ctx) {
  const { agent, state, openPicker, pushLine, pushLabel, render } = ctx
  const slots = listSlots(agent.cwd)
  if (slots.length === 0) {
    pushLine("No archived sessions (use /new and old sessions auto-archive to slots)", C.dim)
  } else {
    const entries = [
      { type: "header", text: `Archived sessions (↑↓ select, Enter switch, Esc cancel)` },
      ...slots.map((s) => ({
        type: "item",
        text: `Slot ${s.slot} — ${s.date}`,
        slot: s.slot,
      })),
    ]
    openPicker({
      title: "Sessions",
      entries,
      onSelect: (e) => {
        const data = switchToSlot(agent.cwd, e.slot)
        if (!data) {
          pushLine(`Slot ${e.slot} not found`, C.dim)
          return
        }
        applySession(agent, data)
        state.lines = data.display.length
          ? data.display.map((l) => ({ text: l.text, color: l.color }))
          : []
        state.tasks = agent.tasks ?? []
        if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
          state.tasks = []
        }
        pushLabel(`── Switched to slot ${e.slot} (${data.history.length} messages) ──`, C.warn)
        render()
      },
    })
  }
}
