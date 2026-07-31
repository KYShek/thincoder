/** /advisor command: toggle advisor on/off, select model, configure thinking.
 *  ctx: { agent, showPicker, pushLine, persistRaw } */
import { C } from "./ansi.mjs"

export async function handleAdvisorCommand(ctx) {
  const { agent, showPicker, pushLine } = ctx
  const cfg = agent.config.advisor ??= {}
  const enabled = cfg.enabled === true
  const curProvider = cfg.provider || "(main)"
  const curModel = cfg.model || agent.provider.model
  const thinkInfo = cfg.thinking === null ? "off"
    : cfg.thinking?.type === "disabled" ? "off"
    : cfg.reasoningEffort ? `on (${cfg.reasoningEffort})`
    : cfg.thinking ? `on (${cfg.thinking.type})` : "(main)"

  const entries = [
    { type: "item", text: `Advisor: ${enabled ? "ON" : "OFF"}`, action: "toggle" },
    { type: "item", text: `Model: ${curModel}`, action: "model", note: `Provider: ${curProvider}` },
    { type: "item", text: `Thinking: ${thinkInfo}`, action: "thinking" },
  ]

  const e = await showPicker("Advisor", entries)
  if (!e) return

  const persist = async () => {
    if (ctx.persistRaw) {
      await ctx.persistRaw((raw) => {
        raw.agent ??= {}
        raw.agent.advisor = cfg
      })
    }
  }

  if (e.action === "toggle") {
    cfg.enabled = !cfg.enabled
    agent._pendingReminders = agent._pendingReminders ?? []
    if (cfg.enabled) {
      agent._pendingReminders.push("[System reminder: Advisor review is now ON. You can call the `advisor` tool to get an independent code review before finalising your work. The advisor is an independent read-only sub-agent that explores the codebase, runs git diff, reads files, and traces callers via grep/lsp.]")
    } else {
      agent._pendingReminders.push("[System reminder: Advisor review is now OFF. The `advisor` tool will not produce results.]")
    }
    await persist().catch(err => pushLine(`[error] Advisor toggle: ${err.message}`, C.error))
  } else if (e.action === "model") {
    await openAdvisorModelPicker(ctx, persist).catch(err => pushLine(`[error] ${err.message}`, C.error))
  } else if (e.action === "thinking") {
    await openAdvisorThinkingPicker(ctx, persist).catch(err => pushLine(`[error] ${err.message}`, C.error))
  }
}

async function openAdvisorModelPicker(ctx, persist) {
  const { agent, showPicker, pushLine } = ctx
  const providers = agent.providers || []
  const cfg = agent.config.advisor ??= {}

  const entries = [
    { type: "item", text: "Use main model", action: "inherit", marker: !cfg.provider ? "●" : "" },
  ]
  for (const p of providers) {
    entries.push({ type: "header", text: p.name, note: p.baseURL + (agent.activeProvider === p.name ? " ← active" : "") })
    const mark = cfg.provider === p.name && cfg.model === p.model ? "● " : "  "
    entries.push({ type: "item", text: `${mark}${p.model}`, action: "switch", provider: p.name, model: p.model })
  }

  // Fire-and-forget: fetch available models from each provider's API
  fetchAdvisorModels(entries, providers).catch(err => pushLine(`[advisor] fetch models: ${err.message}`, C.error))

  const e = await showPicker("Advisor Model", entries)
  if (!e) return

  if (e.action === "inherit") {
    delete cfg.provider
    delete cfg.model
    pushLine("Advisor: using main model", C.dim)
  } else if (e.action === "switch") {
    cfg.provider = e.provider
    cfg.model = e.model
    pushLine(`Advisor: ${e.provider}/${e.model}`, C.dim)
  }
  await persist()
}

async function fetchAdvisorModels(entries, providers) {
  const { listModels } = await import("../provider/index.mjs")
  await Promise.all(providers.map(async (p) => {
    try {
      const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
      let apiKey = p.apiKey
      if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
      if (!apiKey) apiKey = process.env.THINCODER_API_KEY
      const models = await listModels({ baseURL: p.baseURL, apiKey: apiKey ?? "" }, { signal: AbortSignal.timeout(10000) })
      const at = entries.findLastIndex((e) => e.type === "header" && e.text === p.name)
      if (at < 0) return
      // Insert fetched models after the header, before the next provider's header
      entries.splice(at + 2, 0, ...models
        .filter((m) => m !== p.model)
        .map((m) => ({ type: "item", text: `   ${m}`, action: "switch", provider: p.name, model: m })))
      const header = entries[at]
      header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
    } catch {
      const header = entries.find((e) => e.type === "header" && e.text === p.name)
      if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}  (fetch failed)`
    }
  }))
}

async function openAdvisorThinkingPicker(ctx, persist) {
  const { agent, showPicker, pushLine } = ctx
  const { specForModel } = await import("../config.mjs")
  const cfg = agent.config.advisor ??= {}

  const providerForDefaults = cfg.provider
    ? agent.providers?.find(p => p.name === cfg.provider) || agent.provider
    : agent.provider
  const effectiveModel = cfg.model || providerForDefaults.model
  const spec = specForModel(effectiveModel)
  const thinkOnValue = spec.thinkEnabledValue ?? "enabled"
  const isCustomThink = thinkOnValue !== "enabled"
  const isEffortOnly = spec.thinkApi === "effort"
  const effortLevels = spec.reasoningEffortEnum ?? ["high", "max"]

  const curEffort = cfg.reasoningEffort ?? providerForDefaults.reasoningEffort
  const curThinking = cfg.thinking ?? providerForDefaults.thinking
  const thinkingEnabled = curThinking?.type === thinkOnValue
    || (curThinking?.type === undefined && !isCustomThink)

  const entries = [
    { type: "item", text: "Use main model settings", action: "inherit" },
  ]
  if (!isEffortOnly) {
    entries.push({ type: "header", text: "Thinking mode" })
    entries.push({ type: "item", text: `Enabled ${thinkingEnabled ? "← current" : ""}`, action: "think_on" })
    entries.push({ type: "item", text: `Disabled ${curThinking?.type === "disabled" || curThinking === null ? "← current" : ""}`, action: "think_off" })
  }
  entries.push({ type: "header", text: "Reasoning effort" })
  for (const level of effortLevels) {
    entries.push({ type: "item", text: `${level} ${curEffort === level ? "← current" : ""}`, action: `effort_${level}` })
  }

  const e = await showPicker("Advisor Thinking", entries)
  if (!e) return

  if (e.action === "inherit") {
    delete cfg.thinking
    delete cfg.reasoningEffort
    pushLine("Advisor: using main model thinking settings", C.dim)
  } else if (e.action === "think_on") {
    cfg.thinking = { type: thinkOnValue }
    if (isEffortOnly) delete cfg.thinking
    pushLine(`Advisor: thinking ON (${thinkOnValue})`, C.dim)
  } else if (e.action === "think_off") {
    cfg.thinking = isCustomThink ? null : { type: "disabled" }
    pushLine("Advisor: thinking OFF", C.dim)
  } else if (e.action.startsWith("effort_")) {
    cfg.reasoningEffort = e.action.slice(7)
    pushLine(`Advisor: reasoning effort = ${cfg.reasoningEffort}`, C.dim)
  }
  await persist()
}
