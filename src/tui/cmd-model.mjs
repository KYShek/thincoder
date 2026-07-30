import { C } from "./ansi.mjs"

/** /model command: open model picker, or switch provider directly via `/model <provider>`.
 *  ctx: { agent, openModelPicker, selectModel, pushLine } */
export async function handleModelCommand(ctx, args = []) {
  const name = args[0]?.toLowerCase()
  if (!name) {
    ctx.openModelPicker().catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
    return
  }
  const target = ctx.agent.providers.find((p) => p.name.toLowerCase() === name)
  if (!target) {
    const available = ctx.agent.providers.map((p) => p.name).join(", ")
    ctx.pushLine(`Unknown provider: ${args[0]} (available: ${available})`, C.error)
    return
  }
  await ctx.selectModel({ provider: target.name, model: target.model }).catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
}
