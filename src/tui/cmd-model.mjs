import { C } from "./ansi.mjs"

/** /model command: open model picker.
 *  ctx: { openModelPicker, pushLine } */
export async function handleModelCommand(ctx) {
  ctx.openModelPicker().catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
}
