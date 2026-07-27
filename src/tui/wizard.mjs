/**
 * wizard.mjs — 首次启动 Config 向导
 * 从 index.mjs 抽出：provider 选择 → 逐项输入 (name/baseURL/model/key/embedkey) → 持久化 → 接模型选择器。
 * 通过 ctx 对象访问 startTUI 闭包中的共享状态与 UI 函数。
 * ctx: { agent, state, pushLine, pushLabel, render, persistRaw, openModelPicker }
 */

import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"
import { ansi, C } from "./ansi.mjs"

/**
 * 创建向导控制器。
 * 返回 { startWizard, renderWizard, wizardChooseProvider, wizardSubmitText, cancelWizard, finishWizard }
 */
export function createWizard(ctx) {
  const { agent, state, pushLine, pushLabel, render, persistRaw } = ctx

  /** 菜单步的候选项：已有 provider (no key 的标注）+ 未添加的预设 + 自定义 */
  function wizardProviderItems() {
    const items = []
    for (const p of agent.providers) {
      items.push({ kind: "existing", name: p.name, baseURL: p.baseURL, model: p.model, label: `${p.name} (added${p.apiKey ? "" : ", no key"})` })
    }
    for (const [name, p] of Object.entries(PRESETS)) {
      if (!agent.providers.some((x) => x.name === name)) {
        items.push({ kind: "preset", name, baseURL: p.baseURL, model: p.model, label: `${name} (${p.desc})` })
      }
    }
    items.push({ kind: "custom", name: null, label: "Custom endpoint…" })
    return items
  }

  /** 文本步骤定义：提示语 + 校验 (通过返回 true，否则返回错误文案） */
  const WIZARD_STEPS = {
    name: {
      prompt: "Name this provider (alphanumeric/-/_ e.g. my-openai)",
      validate: (v) =>
        (/^[\w-]+$/.test(v) && !agent.providers.some((p) => p.name === v)) || "Name must be alphanumeric/-/_ and unique",
    },
    baseURL: {
      prompt: "Enter baseURL (e.g. https://api.openai.com/v1)",
      validate: (v) => /^https?:\/\/.+/.test(v) || "baseURL must start with http(s)://",
    },
    model: {
      prompt: "Enter model name (e.g. gpt-4o)",
      validate: (v) => v.length > 0 || "Model name required",
    },
    key: {
      prompt: "Enter API key",
      validate: (v) => v.length > 0 || "Key must not be empty",
    },
    embedkey: {
      prompt: "Optional: embedding API key (SiliconFlow, for memory vector search; press Enter to skip)",
      validate: () => true, // 可跳过
    },
  }
  const WIZARD_NEXT = { name: "baseURL", baseURL: "model", model: "key", key: "embedkey", embedkey: null }

  function startWizard() {
    state.wizard = { step: "provider", index: 0, scroll: 0, selectedLine: 0, fields: {}, error: null, lines: [] }
    renderWizard()
  }

  function renderWizard() {
    const w = state.wizard
    if (!w) return
    const lines = []
    if (w.step === "provider") {
      lines.push({ text: " Choose a model provider:", color: C.text })
      wizardProviderItems().forEach((it, i) => {
        if (i === w.index) w.selectedLine = lines.length
        lines.push({
          text: `${i === w.index ? " ▸ " : "   "}${it.label}`,
          color: i === w.index ? ansi.bold + C.text : C.dim,
        })
      })
    } else {
      const f = w.fields
      if (f.name) lines.push({ text: ` Provider:  ${f.name}`, color: C.dim })
      if (f.baseURL) lines.push({ text: ` baseURL: ${f.baseURL}`, color: C.dim })
      if (f.model) lines.push({ text: ` Model:   ${f.model}`, color: C.dim })
      lines.push({ text: ` ❯ ${WIZARD_STEPS[w.step].prompt}`, color: ansi.bold + C.text })
      lines.push({ text: " (type in input box below)", color: C.dim })
      w.selectedLine = 0
    }
    if (w.error) lines.push({ text: ` ${w.error}`, color: C.error })
    w.lines = lines
    render()
  }

  function wizardChooseProvider(item) {
    const w = state.wizard
    if (item.kind === "custom") {
      w.step = "name"
    } else {
      w.fields = { name: item.name, baseURL: item.baseURL, model: item.model }
      w.step = "key"
    }
    renderWizard()
  }

  function wizardSubmitText() {
    const w = state.wizard
    const value = state.input.join("").trim()
    const ok = WIZARD_STEPS[w.step].validate(value)
    if (ok !== true) {
      w.error = ok
      renderWizard()
      return
    }
    w.error = null
    state.input = []
    state.cursor = 0
    w.fields[w.step === "key" ? "key" : w.step] = w.step === "baseURL" ? value.replace(/\/+$/, "") : value
    const next = WIZARD_NEXT[w.step]
    if (next) {
      w.step = next
      renderWizard()
    } else {
      finishWizard().catch((e) => pushLine(`[error] ${e.message}`, C.error))
    }
  }

  function cancelWizard() {
    state.wizard = null
    pushLine("Skipped initial setup. Add a provider anytime via /provider add, set its key via /provider key.", C.dim)
    render()
  }

  /** 向导完成：写入 provider (有则更新）、设为激活、持久化，然后接模型选择器 */
  async function finishWizard() {
    const f = state.wizard.fields
    state.wizard = null
    const existing = agent.providers.find((p) => p.name === f.name)
    if (existing) Object.assign(existing, { baseURL: f.baseURL, model: f.model, apiKey: f.key })
    else agent.providers.push({ name: f.name, baseURL: f.baseURL, model: f.model, apiKey: f.key })
    agent.activeProvider = f.name
    agent.provider = { ...agent.providers.find((p) => p.name === f.name) }
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("../config.mjs")
      agent.config.agent.compactThreshold = resolveCompactThreshold(null, f.model).value
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = f.name
    })
    agent.config.activeProvider = f.name
    pushLabel(`❯ Setup`, ansi.bold + C.tool)
    pushLine(`Setup complete: ${f.name} / ${f.model} (saved to config)`, C.tool)
    // embedding key：配了就启用向量检索，没配提示事后通道
    if (f.embedkey) {
      agent.config.embedding ??= {}
      agent.config.embedding.apiKey = f.embedkey
      await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: f.embedkey } })
      if (agent.memory && !agent.memory.embedder) {
        const { createEmbedder } = await import("../embedding.mjs")
        agent.memory.embedder = createEmbedder(agent.config.embedding)
      }
      pushLine(`Vector search enabled (${agent.config.embedding.model ?? "BAAI/bge-m3"})`, C.tool)
    } else {
      pushLine(`Vector search disabled (memory falls back to text-only search). Run /config embedkey <key> to enable.`, C.dim)
    }
    pushLine(`Select model (Esc to keep ${f.model})`, C.dim)
    ctx.openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
  }

  return { startWizard, renderWizard, wizardChooseProvider, wizardSubmitText, cancelWizard, finishWizard }
}
