import { ansi, C } from "./ansi.mjs"

/** /think 命令：切换思考模式、设置 reasoning effort。
 *  从 slash-commands.mjs 抽出。
 *  ctx: { agent, pushLine, pushLabel, openPicker, syncProviderField } */
export async function handleThinkCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, syncProviderField } = ctx
  const cur = agent.provider
  const thinkingEnabled = cur.thinking?.type === "enabled" || cur.thinking?.type === undefined
  const { specForModel } = await import("../config.mjs")
  const spec = specForModel(cur.model)
  const isEffortOnly = spec.thinkApi === "effort"
  const entries = []
  if (!isEffortOnly) {
    entries.push({ type: "item", text: `Thinking: ${thinkingEnabled ? "ON" : "OFF"}`, action: thinkingEnabled ? "off" : "on" })
  }
  if (spec.reasoningEffortEnum) {
    for (const level of spec.reasoningEffortEnum) {
      const mark = cur.reasoningEffort === level ? "▸ " : "  "
      entries.push({ type: "item", text: `${mark}effort: ${level}`, action: "effort", level })
    }
  } else {
    entries.push({ type: "item", text: "effort: high", action: "effort", level: "high" })
    entries.push({ type: "item", text: "effort: max", action: "effort", level: "max" })
  }
  openPicker({
    title: "Think",
    entries,
    onSelect: async (e) => {
      if (e.action === "effort") {
        cur.reasoningEffort = e.level
        await syncProviderField("reasoningEffort", e.level)
        pushLabel(`❯ Think`, ansi.bold + C.tool)
        pushLine(`Reasoning effort set to ${e.level}`, C.tool)
      } else {
        const enable = e.action === "on"
        if (isEffortOnly) {
          if (!enable) delete cur.reasoningEffort
          else if (!cur.reasoningEffort) cur.reasoningEffort = "high"
          if (!enable) await syncProviderField("reasoningEffort", undefined)
          else await syncProviderField("reasoningEffort", cur.reasoningEffort)
        } else {
          cur.thinking = enable ? { type: "enabled" } : { type: "disabled" }
          if (!enable) delete cur.reasoningEffort
          else if (!cur.reasoningEffort) cur.reasoningEffort = "high"
          await syncProviderField("thinking", cur.thinking)
          if (!enable) await syncProviderField("reasoningEffort", undefined)
          else await syncProviderField("reasoningEffort", cur.reasoningEffort)
        }
        pushLabel(`❯ Think`, ansi.bold + C.tool)
        pushLine(`Thinking mode ${enable ? "On" : "Off"}`, C.tool)
        if (enable) pushLine(`Reasoning effort: ${cur.reasoningEffort}`, C.dim)
      }
    },
  })
}
