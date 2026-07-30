import { sliceByWidth } from "./render.mjs"
import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"

/** Generic list picker + model/provider management. */
export function createPickers(ctx) {
  const { agent, state, render, ansi, C, pushLine, persistRaw, askQuestion, maskKey } = ctx

  function openPicker({ title, entries, onSelect, onCancel, defaultIndex = 0 }) {
    state.picker = { title, entries, lines: [], index: defaultIndex, scroll: 0, selectedLine: 0, onSelect, onCancel }
    rebuildLines()
  }

  function closePicker() {
    state.picker?.onCancel?.()
    state.picker = null
    render()
  }

  /** Promise-based picker: shows picker, returns selected entry (or null if Esc). */
  function showPicker(title, entries) {
    closePicker()
    return new Promise((resolve) => {
      state._pickerResolve = resolve
      state.picker = { title, entries, lines: [], index: 0, scroll: 0, selectedLine: 0 }
      rebuildLines()
    })
  }

  /** Called by key handler: resolve the active promise picker. Returns true if resolved. */
  function resolvePicker(entry) {
    if (!state._pickerResolve) return false
    const resolve = state._pickerResolve
    state._pickerResolve = null
    state.picker = null
    render()
    resolve(entry)
    return true
  }

  function rebuildLines() {
    const p = state.picker
    if (!p) return
    const lines = []
    let row = 0, selLine = 0
    for (const e of p.entries) {
      if (e.type === "header") {
        lines.push({ text: ` ${e.text}${e.note ? `  ${e.note}` : ""}`, color: ansi.bold + C.tool })
      } else {
        const sel = row === p.index
        if (sel) selLine = lines.length
        const marker = e.marker ? `  ${e.marker}` : ""
        lines.push({ text: `${sel ? " ▸ " : "   "}${e.text}${marker}`, color: sel ? ansi.bold + C.text : C.dim })
        row++
      }
    }
    p.lines = lines
    p.selectedLine = selLine
    render()
  }

  function renderPickerLines() { rebuildLines() }

  // === model picker ===

  async function openModelPicker() {
    const entries = buildModelEntries()
    openPicker({
      title: "Models & Providers",
      entries,
      onSelect: async (e) => {
        if (e.action === "switch") await selectModel(e).catch(err => pushLine(`[error] ${err.message}`, C.error))
        else if (e.action === "add") await addProviderFlow()
        else if (e.action === "remove") await removeProviderFlow()
        else if (e.action === "key") await setKeyFlow()
      },
    })
    const current = (state.picker?.entries.filter(e => e.type === "item") ?? []).findIndex(
      e => e.action === "switch" && e.provider === agent.activeProvider && e.model === agent.provider.model)
    if (current >= 0) state.picker.index = current
    rebuildLines()

    const { listModels } = await import("../provider/index.mjs")
    await Promise.all(agent.providers.map(async p => {
      try {
        const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
        let apiKey = p.apiKey
        if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
        if (!apiKey) apiKey = process.env.THINCODER_API_KEY
        const models = await listModels({ baseURL: p.baseURL, apiKey: apiKey ?? "" }, { signal: AbortSignal.timeout(10000) })
        const at = entries.findLastIndex(e => e.type === "item" && e.action === "switch" && e.provider === p.name)
        if (at >= 0) entries.splice(at + 1, 0, ...models.filter(m => m !== p.model).map(m => ({ type: "item", text: m, action: "switch", provider: p.name, model: m })))
        const header = entries.find(e => e.type === "header" && e.text === p.name)
        if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
      } catch (error) {
        const header = entries.find(e => e.type === "header" && e.text === p.name)
        if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}  (fetch failed: ${sliceByWidth(error.message, 40)})`
      }
      if (state.picker?.entries === entries) rebuildLines()
    }))
  }

  function buildModelEntries() {
    const entries = []
    for (const p of agent.providers) {
      const active = p.name === agent.activeProvider
      entries.push({ type: "header", text: p.name, note: `${p.baseURL}${p.apiKey ? "" : " (no key)"}${active ? " ← current" : ""}  loading...` })
      entries.push({ type: "item", text: p.model, action: "switch", provider: p.name, model: p.model, marker: active ? "●" : "" })
    }
    entries.push({ type: "header", text: "Provider Management" })
    entries.push({ type: "item", text: "Add provider…", action: "add" })
    if (agent.providers.length > 1) entries.push({ type: "item", text: "Remove provider…", action: "remove" })
    entries.push({ type: "item", text: "Set / change API key…", action: "key" })
    return entries
  }

  async function selectModel(item) {
    closePicker()
    const target = agent.providers.find(pp => pp.name === item.provider)
    if (!target) return
    target.model = item.model
    agent.activeProvider = item.provider
    agent.provider = { ...target }
    if (!agent.provider.apiKey) {
      const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[item.provider]
      if (envKey && process.env[envKey]) agent.provider.apiKey = process.env[envKey]
    }
    if (!agent.provider.apiKey) agent.provider.apiKey = process.env.THINCODER_API_KEY
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("../config.mjs")
      agent.config.agent.compactThreshold = resolveCompactThreshold(null, item.model).value
    }
    await persistRaw((raw) => { raw.providers = agent.providers; raw.activeProvider = item.provider })
    agent.config.activeProvider = item.provider
    if (!agent.provider.apiKey) {
      const selKey = await askQuestion(`Enter API key for ${item.provider} (leave empty to skip):`)
      if (selKey) await setProviderKey(item.provider, selKey)
    }
  }

  async function addProviderFlow() {
    closePicker()
    const entries = [
      { type: "header", text: "Select a preset provider" },
      ...Object.entries(PRESETS).filter(([name]) => !agent.providers.some(p => p.name === name))
        .map(([name, p]) => ({ type: "item", text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`, name, kind: "preset" })),
      { type: "header", text: "Other" },
      { type: "item", text: "Custom (manual config)", name: "__custom__", kind: "custom" },
    ]
    openPicker({
      title: "Add Provider", entries,
      onSelect: async (se) => {
        closePicker()
        if (se.kind === "custom") {
          const name = await askQuestion("Enter provider name:")
          if (!name) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
          if (agent.providers.some(p => p.name === name)) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
          const baseURL = (await askQuestion("Enter baseURL:")).replace(/\/+$/, "")
          if (!baseURL) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
          const model = await askQuestion("Enter model name:")
          if (!model) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
          agent.providers.push({ name, baseURL, model })
          await persistRaw(raw => { raw.providers = agent.providers })
          const key = await askQuestion(`Enter API key for ${name} (skip if none):`)
          if (key) await setProviderKey(name, key)
          openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error))
          return
        }
        const preset = PRESETS[se.name]
        if (!preset || agent.providers.some(p => p.name === se.name)) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
        const cfg = { name: se.name, baseURL: preset.baseURL, model: preset.model }
        if (preset.thinking) cfg.thinking = preset.thinking
        if (preset.reasoningEffort) cfg.reasoningEffort = preset.reasoningEffort
        if (preset.maxTokens) cfg.maxTokens = preset.maxTokens
        if (preset.chatPath) cfg.chatPath = preset.chatPath
        agent.providers.push(cfg)
        await persistRaw(raw => { raw.providers = agent.providers })
        const key = await askQuestion(`Enter API key for ${se.name} (skip if none):`)
        if (key) await setProviderKey(se.name, key)
        openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error))
      },
    })
  }

  async function removeProviderFlow() {
    closePicker()
    const candidates = agent.providers.filter(p => p.name !== agent.activeProvider)
    if (!candidates.length) { openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error)); return }
    openPicker({
      title: "Remove Provider",
      entries: [
        { type: "header", text: "Select provider to remove" },
        ...candidates.map(p => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
      ],
      onSelect: async (se) => {
        closePicker()
        agent.providers.splice(agent.providers.findIndex(p => p.name === se.name), 1)
        await persistRaw(raw => { raw.providers = agent.providers })
        openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error))
      },
    })
  }

  async function setKeyFlow() {
    closePicker()
    openPicker({
      title: "Configure API Key",
      entries: [
        { type: "header", text: "Select provider" },
        ...agent.providers.map(p => ({ type: "item", text: `${p.name} ${p.apiKey ? `(has key: ${maskKey(p.apiKey)})` : "(no key)"}`, name: p.name })),
      ],
      onSelect: async (se) => {
        closePicker()
        const key = await askQuestion(`Enter API key for ${se.name}:`)
        if (key) { await setProviderKey(se.name, key) }
        openModelPicker().catch(e => pushLine(`[error] ${e.message}`, C.error))
      },
    })
  }

  async function setProviderKey(name, key) {
    const target = agent.providers.find(p => p.name === name)
    if (!target) return
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw(raw => { raw.providers = agent.providers })
  }

  return { openPicker, closePicker, showPicker, resolvePicker, renderPickerLines, openModelPicker, setProviderKey }
}
