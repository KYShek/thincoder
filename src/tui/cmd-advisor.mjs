/** /advisor command: toggle advisor on/off, select model.
 *  ctx: { agent, openPicker, pushLine } */
import { C } from "./ansi.mjs"

export async function handleAdvisorCommand(ctx) {
  const { agent, openPicker, pushLine } = ctx
  const cfg = agent.config.advisor ??= {}
  const enabled = cfg.enabled === true
  const curProvider = cfg.provider || agent.activeProvider
  const curModel = cfg.model || agent.provider.model

  const entries = [
    { type: "item", text: `Advisor: ${enabled ? "ON" : "OFF"}`, action: "toggle" },
    { type: "item", text: `Model: ${curProvider}/${curModel}`, action: "model" },
  ]

  openPicker({
    title: "Advisor",
    entries,
    onSelect: async (e) => {
      if (e.action === "toggle") {
        cfg.enabled = !cfg.enabled
        agent._pendingReminders = agent._pendingReminders ?? []
        if (cfg.enabled) {
          agent._pendingReminders.push("[系统提醒: Advisor 审查已开启。每轮操作后，你的输出将被审查，观察结果可能作为系统提醒注入。请批判性参考——这是观察，不是命令。]")
        } else {
          agent._pendingReminders.push("[系统提醒: Advisor 审查已关闭。后续轮次不再自动审查。]")
        }
      } else if (e.action === "model") {
        await openAdvisorModelPicker(ctx).catch(err => pushLine(`[error] ${err.message}`, C.error))
      }
    },
  })
}

async function openAdvisorModelPicker(ctx) {
  const { agent, openPicker, pushLine } = ctx
  const providers = agent.providers || []

  // Build flat list: each provider's name + a "use current model" entry
  const entries = []
  let idx = 0
  for (const p of providers) {
    const mark = p.name === agent.activeProvider ? "* " : "  "
    entries.push({ type: "item", text: `${mark}${p.name} — ${p.baseURL}`, action: "set_provider", provider: p.name, model: p.model })
    idx++
  }

  openPicker({
    title: "Advisor Model",
    entries,
    onSelect: async (e) => {
      if (e.action === "set_provider") {
        const cfg = agent.config.advisor ??= {}
        if (e.provider === agent.activeProvider && e.model === agent.provider.model) {
          // Same as main — clear override (use main pool)
          delete cfg.provider
          delete cfg.model
          pushLine(`Advisor: 使用主模型 (${agent.activeProvider}/${agent.provider.model})`, C.dim)
        } else {
          cfg.provider = e.provider
          cfg.model = e.model
          pushLine(`Advisor: ${e.provider}/${e.model}`, C.dim)
        }
      }
    },
  })
}
