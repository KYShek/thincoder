/** /think command: toggle thinking mode, set reasoning effort.
 *  Interactive loop UX — stays in menu after each action, Esc to exit.
 *  ctx: { agent, showPicker, syncProviderField, pushLine, pushLabel } */
import { ansi, C } from "./ansi.mjs"

export async function handleThinkCommand(ctx, args = []) {
  const { agent, showPicker, syncProviderField, pushLine, pushLabel } = ctx
  const { specForModel } = await import("../config.mjs")

  // Fast path: direct args — exit immediately
  const cur = agent.provider
  const spec = specForModel(cur.model)
  const isEffortOnly = spec.thinkApi === "effort"
  const thinkOnValue = spec.thinkEnabledValue ?? "enabled"
  const isCustomThink = thinkOnValue !== "enabled"
  const effortLevels = spec.reasoningEffortEnum ?? ["high", "max"]

  const autoThinkEnabled = agent.config?.agent?.autoThink === true
  const sub = args[0]?.toLowerCase()
  if (sub === "on" || sub === "off") {
    if (autoThinkEnabled) { pushLine("Auto-think is ON — manual settings are overridden each turn; turn Auto off first via /think", C.error); return }
    await applyThink({ action: sub }, agent, syncProviderField, spec, isEffortOnly, isCustomThink, thinkOnValue)
    pushLabel("❯ Think", ansi.bold + C.tool)
    pushLine(`Thinking: ${sub}`, C.tool)
    return
  }
  if (sub === "effort") {
    const level = args[1]?.toLowerCase()
    if (!level || !effortLevels.includes(level)) {
      pushLine(`Usage: /think effort <${effortLevels.join("|")}>`, C.error)
      return
    }
    if (autoThinkEnabled) { pushLine("Auto-think is ON — manual settings are overridden each turn; turn Auto off first via /think", C.error); return }
    await applyThink({ action: "effort", level }, agent, syncProviderField, spec, isEffortOnly, isCustomThink, thinkOnValue)
    pushLabel("❯ Think", ansi.bold + C.tool)
    pushLine(`Thinking effort: ${level}`, C.tool)
    return
  }
  if (sub) { pushLine("Usage: /think [on|off|effort <level>]", C.error); return }

  // ── Interactive loop ──
  let mainIdx = 0
  for (;;) {
    const autoOn = agent.config?.agent?.autoThink === true
    const thinkingEnabled = cur.thinking?.type === thinkOnValue
      || (cur.thinking?.type === undefined && !isCustomThink)

    const entries = [
      { type: "header", text: `Auto: ${autoOn ? "ON" : "OFF"} | Thinking: ${thinkingEnabled ? "ON" : "OFF"} | Effort: ${cur.reasoningEffort || "—"}` },
      { type: "item", text: `Auto: ${autoOn ? "ON" : "OFF"}`, action: "auto" },
    ]
    if (!isEffortOnly && !autoOn) {
      entries.push({ type: "item", text: `Thinking: ${thinkingEnabled ? "ON" : "OFF"}`, action: thinkingEnabled ? "off" : "on" })
    }
    if (!autoOn) {
      for (const level of effortLevels) {
        const mark = cur.reasoningEffort === level ? "▸ " : "  "
        entries.push({ type: "item", text: `${mark}effort: ${level}`, action: "effort", level })
      }
    }

    const e = await showPicker("Think", entries, { defaultIndex: mainIdx })
    if (!e) return // Esc
    mainIdx = Math.max(0, entries.filter((en) => en.type === "item").indexOf(e))

    const prevAuto = autoOn
    const prevThinking = thinkingEnabled
    const prevEffort = cur.reasoningEffort

    await applyThink(e, agent, syncProviderField, spec, isEffortOnly, isCustomThink, thinkOnValue)

    // Feedback
    pushLabel("❯ Think", ansi.bold + C.tool)
    if (e.action === "auto") {
      const newAuto = agent.config?.agent?.autoThink === true
      pushLine(`Auto-think: ${newAuto ? "ON" : "OFF"}`, C.tool)
    } else if (e.action === "effort") {
      pushLine(`Reasoning effort: ${e.level}`, C.tool)
    } else {
      const nowEnabled = cur.thinking?.type === thinkOnValue
        || (cur.thinking?.type === undefined && !isCustomThink)
      pushLine(`Thinking: ${nowEnabled ? "ON" : "OFF"}`, C.tool)
    }
  }
}

/** Shared apply logic — extracted from handleThinkCommand for reuse in both fast path and loop */
async function applyThink(e, agent, syncProviderField, spec, isEffortOnly, isCustomThink, thinkOnValue) {
  const cur = agent.provider
  if (e.action === "auto") {
    const cfg = agent.config.agent ??= {}
    cfg.autoThink = !cfg.autoThink
    agent._pendingReminders = agent._pendingReminders ?? []
    if (cfg.autoThink) {
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
