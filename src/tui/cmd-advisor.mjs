/** /advisor command: toggle advisor on/off, select model, configure thinking.
 *  ctx: { agent, showPicker, pushLine, selectAdvisorModel, askQuestion, syncProviderField } */
import { C } from "./ansi.mjs"

export async function handleAdvisorCommand(ctx) {
  const { agent, showPicker, pushLine } = ctx
  const cfg = agent.config.advisor ??= {}
  const enabled = cfg.enabled === true
  const curProvider = cfg.provider || "(main)"
  const curModel = cfg.model || agent.provider.model
  const thinkInfo = cfg.thinking?.type === "disabled" ? "off"
    : cfg.reasoningEffort ? `on (${cfg.reasoningEffort})`
    : cfg.thinking?.type === "enabled" ? "on" : "(main)"

  const entries = [
    { type: "item", text: `Advisor: ${enabled ? "ON" : "OFF"}`, action: "toggle" },
    { type: "item", text: `Model: ${curModel}`, action: "model", note: `Provider: ${curProvider}` },
    { type: "item", text: `Thinking: ${thinkInfo}`, action: "thinking" },
  ]

  const e = await showPicker("Advisor", entries)
  if (!e) return

  if (e.action === "toggle") {
    cfg.enabled = !cfg.enabled
    agent._pendingReminders = agent._pendingReminders ?? []
    if (cfg.enabled) {
      agent._pendingReminders.push("[System reminder: Advisor review is now ON. You can call the `advisor` tool to get an independent code review before finalising your work. The review uses your git diff, changed files, and review criteria from .thincoder/advisor.md.]")
    } else {
      agent._pendingReminders.push("[System reminder: Advisor review is now OFF. The `advisor` tool will not produce results.]")
    }
  } else if (e.action === "model") {
    await openAdvisorModelPicker(ctx).catch(err => pushLine(`[error] ${err.message}`, C.error))
  } else if (e.action === "thinking") {
    await openAdvisorThinkingPicker(ctx).catch(err => pushLine(`[error] ${err.message}`, C.error))
  }
}

async function openAdvisorModelPicker(ctx) {
  const { agent, showPicker, pushLine } = ctx
  const providers = agent.providers || []
  const cfg = agent.config.advisor ??= {}

  const entries = []
  for (const p of providers) {
    const mark = cfg.provider === p.name ? "● " : "  "
    entries.push({ type: "header", text: p.name, note: p.baseURL + (cfg.provider === p.name ? " ← current" : "") })
    entries.push({ type: "item", text: `${mark}${p.model}`, action: "switch", provider: p.name, model: p.model })
    // Also add common alternative models per provider
    for (const alt of altModels(p)) {
      if (alt === p.model) continue
      entries.push({ type: "item", text: `   ${alt}`, action: "switch", provider: p.name, model: alt })
    }
  }

  const e = await showPicker("Advisor Model", entries)
  if (e?.action !== "switch") return

  cfg.provider = e.provider
  cfg.model = e.model
  pushLine(`Advisor: ${e.provider}/${e.model}`, C.dim)
}

function altModels(p) {
  const m = p.model
  // Common DeepSeek models
  if (p.name === "deepseek") return [m, "deepseek-chat", "deepseek-v4-pro"].filter((v, i, a) => a.indexOf(v) === i)
  // Common OpenRouter/OpenAI models
  if (p.name === "openai") return [m, "gpt-4o", "gpt-4o-mini", "o4-mini"].filter((v, i, a) => a.indexOf(v) === i)
  // Just show the current model
  return [m]
}

async function openAdvisorThinkingPicker(ctx) {
  const { agent, showPicker, pushLine } = ctx
  const cfg = agent.config.advisor ??= {}

  const curEffort = cfg.reasoningEffort ?? agent.provider.reasoningEffort
  const curThinking = cfg.thinking ?? agent.provider.thinking

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
    cfg.thinking = { type: "enabled" }
    pushLine("Advisor: thinking ON", C.dim)
  } else if (e.action === "think_off") {
    cfg.thinking = { type: "disabled" }
    pushLine("Advisor: thinking OFF", C.dim)
  } else if (e.action.startsWith("effort_")) {
    cfg.reasoningEffort = e.action.slice(7)  // "effort_max" → "max"
    pushLine(`Advisor: reasoning effort = ${cfg.reasoningEffort}`, C.dim)
  }
}
