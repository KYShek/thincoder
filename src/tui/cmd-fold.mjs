/**
 * cmd-fold.mjs — /fold command: toggle conversation result folding
 */
import { C } from "./ansi.mjs"

export async function handleFoldCommand(ctx, args = []) {
  const { state } = ctx
  const arg = args[0]?.toLowerCase()
  if (arg === "on") {
    state.foldEnabled = true
    ctx.pushLine("Folding: on (long tool results are collapsed)", C.dim)
  } else if (arg === "off") {
    state.foldEnabled = false
    ctx.pushLine("Folding: off (all results shown in full)", C.dim)
  } else {
    state.foldEnabled = !state.foldEnabled
    ctx.pushLine(`Folding: ${state.foldEnabled ? "on" : "off"}`, C.dim)
  }
  ctx.render()
}
