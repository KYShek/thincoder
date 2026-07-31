import { C } from "./ansi.mjs"

/** /model command: open model picker, or switch provider directly via `/model <provider>[:model]`.
 *  ctx: { agent, openModelPicker, selectModel, pushLine } */
export async function handleModelCommand(ctx, args = []) {
  const raw = args[0]?.toLowerCase()
  if (!raw) {
    ctx.openModelPicker().catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
    return
  }
  // Parse "provider:model" syntax
  const colonIdx = raw.indexOf(":")
  const providerName = colonIdx >= 0 ? raw.slice(0, colonIdx) : raw
  const modelName = colonIdx >= 0 ? raw.slice(colonIdx + 1) : null

  const target = ctx.agent.providers.find((p) => p.name.toLowerCase() === providerName)
  if (!target) {
    const available = ctx.agent.providers.map((p) => p.name).join(", ")
    ctx.pushLine(`Unknown provider: ${providerName} (available: ${available})`, C.error)
    return
  }
  await ctx.selectModel({ provider: target.name, model: modelName || target.model }).catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
}
