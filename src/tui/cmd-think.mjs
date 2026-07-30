import { C } from "./ansi.mjs"

/** /think command: toggle thinking mode, set reasoning effort.
 *  Extracted from slash-commands.mjs.
 *  ctx: { agent, showPicker, syncProviderField, pushLine } */
export async function handleThinkCommand(ctx, args = []) {
  const { agent, showPicker, syncProviderField, pushLine } = ctx
  const cur = agent.provider
  const { specForModel } = await import("../config.mjs")
  const spec = specForModel(cur.model)
  const isEffortOnly = spec.thinkApi === "effort"
  const thinkOnValue = spec.thinkEnabledValue ?? "enabled"
  const isCustomThink = thinkOnValue !== "enabled"
  const effortLevels = spec.reasoningEffortEnum ?? ["high", "max"]

  async function apply(e) {
    if (e.action === "auto") {
      const cfg = agent.config.agent ??= {}
      cfg.autoThink = !cfg.autoThink
      agent._pendingReminders = agent._pendingReminders ?? []
      if (cfg.autoThink) {
        // Turn off manual effort — auto will set it per-turn
        delete cur.reasoningEffort
        await syncProviderField("reasoningEffort", undefined)
        agent._pendingReminders.push("[System reminder: Auto-think is now ON. Reasoning effort will be automatically set per-task based on difficulty classification.]")
      } else {
        agent._pendingReminders.push("[System reminder: Auto-think is now OFF. Reasoning effort will remain at its current manual setting.]")
      }
    } else if (e.action === "effort") {
      cur.reasoningEffort = e.level
      await syncProviderField("reasoningEffort", e.level)
    } else {
      const enable = e.action === "on"
      if (isEffortOnly) {
        if (!enable) delete cur.reasoningEffort
        else if (!cur.reasoningEffort) cur.reasoningEffort = "high"
        if (!enable) await syncProviderField("reasoningEffort", undefined)
        else await syncProviderField("reasoningEffort", cur.reasoningEffort)
      } else {
        if (enable) {
          cur.thinking = { type: thinkOnValue }
          if (!cur.reasoningEffort) cur.reasoningEffort = "high"
        } else {
          // Custom-think models (MiniMax "adaptive") don't support "disabled" — remove the field instead
          cur.thinking = isCustomThink ? undefined : { type: "disabled" }
          delete cur.reasoningEffort
        }
        await syncProviderField("thinking", cur.thinking)
        if (enable) {
          await syncProviderField("reasoningEffort", cur.reasoningEffort)
        } else {
          await syncProviderField("reasoningEffort", undefined)
        }
      }
    }
  }

  // Direct args: /think on|off │ /think effort <level>
  // autoThink 开启时手动值每轮被覆盖（picker 里也隐藏了开关/effort 项），直参同样拒绝
  const autoThinkEnabled = agent.config?.agent?.autoThink === true
  const sub = args[0]?.toLowerCase()
  if (sub === "on" || sub === "off") {
    if (autoThinkEnabled) { pushLine("Auto-think is ON — manual settings are overridden each turn; turn Auto off first via /think", C.error); return }
    await apply({ action: sub })
    pushLine(`Thinking: ${sub}`, C.dim)
    return
  }
  if (sub === "effort") {
    const level = args[1]?.toLowerCase()
    if (!level || !effortLevels.includes(level)) {
      pushLine(`Usage: /think effort <${effortLevels.join("|")}>`, C.error)
      return
    }
    if (autoThinkEnabled) { pushLine("Auto-think is ON — manual settings are overridden each turn; turn Auto off first via /think", C.error); return }
    await apply({ action: "effort", level })
    pushLine(`Thinking effort: ${level}`, C.dim)
    return
  }
  if (sub) { pushLine("Usage: /think [on|off|effort <level>]", C.error); return }

  // "enabled" when thinking.type matches the model's enabled value, or when thinking is absent and the model is NOT a custom-think model (defaults to on for standard models)
  const thinkingEnabled = cur.thinking?.type === thinkOnValue || (cur.thinking?.type === undefined && !isCustomThink)
  const entries = []
  // Auto-think: classify difficulty per-prompt and auto-set reasoning effort
  entries.push({ type: "item", text: `Auto: ${autoThinkEnabled ? "ON" : "OFF"}`, action: "auto" })
  if (!isEffortOnly) {
    if (!autoThinkEnabled) entries.push({ type: "item", text: `Thinking: ${thinkingEnabled ? "ON" : "OFF"}`, action: thinkingEnabled ? "off" : "on" })
  }
  if (spec.reasoningEffortEnum && !autoThinkEnabled) {
    for (const level of spec.reasoningEffortEnum) {
      const mark = cur.reasoningEffort === level ? "▸ " : "  "
      entries.push({ type: "item", text: `${mark}effort: ${level}`, action: "effort", level })
    }
  } else if (!autoThinkEnabled) {
    entries.push({ type: "item", text: "effort: high", action: "effort", level: "high" })
    entries.push({ type: "item", text: "effort: max", action: "effort", level: "max" })
  }
  const e = await showPicker("Think", entries)
  if (e) await apply(e)
}
