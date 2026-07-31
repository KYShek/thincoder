/** /advisor command: toggle advisor on/off, select model, configure thinking.
 *  ctx: { agent, showPicker, pushLine, persistRaw } */
import { C } from "./ansi.mjs"

export async function handleAdvisorCommand(ctx) {
  const { agent, showPicker, pushLine } = ctx
  const cfg = agent.config.advisor ??= {}
  const enabled = cfg.enabled === true
  const curProvider = cfg.provider || "(main)"
  const curModel = cfg.model || agent.provider.model
  const thinkInfo = cfg.thinking?.type === "disabled" ? "off"
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
    await persist()
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
    const mark = cfg.provider === p.name && cfg.model !== agent.provider.model ? "● " : "  "
    entries.push({ type: "header", text: p.name, note: p.baseURL + (agent.activeProvider === p.name ? " ← active" : "") })
    entries.push({ type: "item", text: `${mark}${p.model}`, action: "switch", provider: p.name, model: p.model })
    for (const alt of altModels(p)) {
      if (alt === p.model) continue
      const altMark = cfg.provider === p.name && cfg.model === alt ? "● " : "  "
      entries.push({ type: "item", text: `   ${altMark}${alt}`, action: "switch", provider: p.name, model: alt })
    }
  }

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

function altModels(p) {
  const m = p.model
  if (p.name === "deepseek") return [m, "deepseek-chat", "deepseek-v4-pro"].filter((v, i, a) => a.indexOf(v) === i)
  if (p.name === "openai") return [m, "gpt-4o", "gpt-4o-mini", "o4-mini"].filter((v, i, a) => a.indexOf(v) === i)
  if (p.name === "kimi") return [m, "kimi-k3", "kimi-k2"].filter((v, i, a) => a.indexOf(v) === i)
  if (p.name === "qwen") return [m, "qwen3.7-max", "qwen-plus"].filter((v, i, a) => a.indexOf(v) === i)
  if (p.name === "glm") return [m, "glm-5.2", "glm-4"].filter((v, i, a) => a.indexOf(v) === i)
  return [m]
}

async function openAdvisorThinkingPicker(ctx, persist) {
  const { agent, showPicker, pushLine } = ctx
  const { specForModel } = await import("../config.mjs")
  const cfg = agent.config.advisor ??= {}

  // Resolve effective provider for thinking defaults
  const providerForDefaults = cfg.provider
    ? agent.providers?.find(p => p.name === cfg.provider) || agent.provider
    : agent.provider
  const effectiveModel = cfg.model || providerForDefaults.model
  const spec = specForModel(effectiveModel)
  const thinkOnValue = spec.thinkEnabledValue ?? "enabled"
  const curEffort = cfg.reasoningEffort ?? providerForDefaults.reasoningEffort
  const curThinking = cfg.thinking ?? providerForDefaults.thinking

  const entries = [
    { type: "item", text: "Use main model settings", action: "inherit" },
    { type: "header", text: "Thinking mode" },
    { type: "item", text: `Enabled ${!curThinking || curThinking.type !== "disabled" ? "← current" : ""}`, action: "think_on" },
    { type: "item", text: `Disabled ${curThinking?.type === "disabled" ? "← current" : ""}`, action: "think_off" },
    { type: "header", text: "Reasoning effort" },
    { type: "item", text: `max ${curEffort === "max" ? "← current" : ""}`, action: "effort_max" },
    { type: "item", text: `high ${curEffort === "high" ? "← current" : ""}`, action: "effort_high" },
    { type: "item", text: `medium ${curEffort === "medium" ? "← current" : ""}`, action: "effort_medium" },
    { type: "item", text: `low ${curEffort === "low" ? "← current" : ""}`, action: "effort_low" },
  ]

  const e = await showPicker("Advisor Thinking", entries)
  if (!e) return

  if (e.action === "inherit") {
    delete cfg.thinking
    delete cfg.reasoningEffort
    pushLine("Advisor: using main model thinking settings", C.dim)
  } else if (e.action === "think_on") {
    cfg.thinking = { type: thinkOnValue }
    pushLine(`Advisor: thinking ON (${thinkOnValue})`, C.dim)
  } else if (e.action === "think_off") {
    cfg.thinking = { type: "disabled" }
    pushLine("Advisor: thinking OFF", C.dim)
  } else if (e.action.startsWith("effort_")) {
    cfg.reasoningEffort = e.action.slice(7)
    pushLine(`Advisor: reasoning effort = ${cfg.reasoningEffort}`, C.dim)
  }
  await persist()
}
