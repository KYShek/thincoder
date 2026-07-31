import { sliceByWidth } from "./render.mjs"
import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"

/** Generic list picker + model/provider management.
 *  单一 Promise API：showPicker(title, entries, { defaultIndex }) → Promise<entry|null>。
 *  picker 栈：state.pickerStack，state.picker 始终指向栈顶（layout/render/key-handler 都只读 state.picker）。
 *  选中即关闭（Enter = resolve + pop）；Esc = pop 当前层并 resolve(null)。菜单循环由调用方 while 重开。 */
export function createPickers(ctx) {
  const { agent, state, render, ansi, C, pushLine, persistRaw, askQuestion, maskKey } = ctx

  state.pickerStack ??= []

  /** 当前 picker 过滤后的 item 列表（filter 大小写不敏感子串匹配，header 不参与） */
  function pickerItems(p) {
    const f = (p.filter ?? "").toLowerCase()
    return p.entries.filter((e) => e.type === "item" && (!f || e.text.toLowerCase().includes(f)))
  }

  /** 弹出栈顶 picker 并 resolve 其 Promise。返回是否有 picker 被弹出。 */
  function popPicker(value) {
    const p = state.pickerStack.pop()
    if (!p) return false
    state.picker = state.pickerStack.at(-1) ?? null
    if (state.picker) rebuildLines()
    else render()
    p.resolve(value)
    return true
  }

  /** 关闭所有 picker：清空栈，挂起者全部 resolve(null)。 */
  function closePicker() {
    while (state.pickerStack.length) popPicker(null)
  }

  /** 打开 picker，返回选中 entry（Esc/取消 → null）。
   *  互斥保护：入栈前把现有挂起 picker 全部 resolve(null)，消除 Promise 悬挂。
   *  （正常嵌套是先 await 上一层返回再开新的，栈深通常为 1。） */
  function showPicker(title, entries, { defaultIndex = 0 } = {}) {
    closePicker()
    return new Promise((resolve) => {
      const itemCount = entries.filter((e) => e.type === "item").length
      const index = Math.max(0, Math.min(defaultIndex, Math.max(0, itemCount - 1)))
      state.picker = { title, entries, lines: [], index, scroll: 0, selectedLine: 0, filter: "", resolve }
      state.pickerStack.push(state.picker)
      rebuildLines()
    })
  }

  function rebuildLines() {
    const p = state.picker
    if (!p) return
    const items = pickerItems(p)
    p.filteredItems = items
    if (p.index >= items.length) p.index = Math.max(0, items.length - 1)
    const lines = []
    let row = 0, selLine = 0
    for (const e of p.entries) {
      if (e.type === "header") {
        lines.push({ text: ` ${e.text}${e.note ? `  ${e.note}` : ""}`, color: ansi.bold + C.tool })
      } else {
        if (!items.includes(e)) continue // 被 filter 滤掉
        const sel = row === p.index
        if (sel) selLine = lines.length
        const marker = e.marker ? `  ${e.marker}` : ""
        lines.push({ text: `${sel ? " ▸ " : "   "}${e.text}${marker}`, color: sel ? ansi.bold + C.text : C.dim })
        row++
      }
    }
    if (p.filter && items.length === 0) lines.push({ text: "   (no match)", color: C.dim })
    p.lines = lines
    p.selectedLine = selLine
    render()
  }

  function renderPickerLines() { rebuildLines() }

  // === model picker ===

  /** entry 唯一标识：异步更新 entries 后按它恢复选中项 */
  function entryKey(e) {
    if (!e) return null
    return e.action === "switch" ? `switch:${e.provider}:${e.model}` : `action:${e.action}`
  }

  async function openModelPicker() {
    // 菜单循环：选中即关闭，子流程结束后重开主菜单；Esc 退出
    for (;;) {
      const entries = buildModelEntries()
      const items = entries.filter((e) => e.type === "item")
      const current = items.findIndex(
        (e) => e.action === "switch" && e.provider === agent.activeProvider && e.model === agent.provider.model)
      const picked = showPicker("Models & Providers", entries, { defaultIndex: Math.max(0, current) })
      // 后台异步拉取各 provider 模型列表，原地更新 entries（不 await，错误仅提示）
      fetchModels(entries).catch((err) => pushLine(`[model] fetch models failed: ${err.message}`, C.error))
      const e = await picked
      if (!e) return
      if (e.action === "switch") {
        await selectModel(e).catch((err) => pushLine(`[error] ${err.message}`, C.error))
        return
      }
      if (e.action === "add") await addProviderFlow()
      else if (e.action === "remove") await removeProviderFlow()
      else if (e.action === "key") await setKeyFlow()
    }
  }

  /** 后台拉取模型列表并 splice 进 entries；更新时按 entryKey 恢复用户光标下的选中项 */
  async function fetchModels(entries) {
    const { listModels } = await import("../provider/index.mjs")
    await Promise.all(agent.providers.map(async (p) => {
      let selKey = null
      try {
        const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
        let apiKey = p.apiKey
        if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
        if (!apiKey) apiKey = process.env.THINCODER_API_KEY
        const models = await listModels({ baseURL: p.baseURL, apiKey: apiKey ?? "" }, { signal: AbortSignal.timeout(10000) })
        if (state.picker?.entries !== entries) return // picker 已关或已换，不再更新
        selKey = entryKey(pickerItems(state.picker)[state.picker.index])
        const at = entries.findLastIndex((e) => e.type === "item" && e.action === "switch" && e.provider === p.name)
        if (at >= 0) entries.splice(at + 1, 0, ...models.filter((m) => m !== p.model).map((m) => ({ type: "item", text: m, action: "switch", provider: p.name, model: m })))
        const header = entries.find((e) => e.type === "header" && e.text === p.name)
        if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
      } catch (error) {
        if (state.picker?.entries !== entries) return
        const header = entries.find((e) => e.type === "header" && e.text === p.name)
        if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}  (fetch failed: ${sliceByWidth(error.message, 40)})`
      }
      // 异步 splice 会改变光标下的项：按 entry 标识恢复选中，找不到则 clamp 到合法范围
      const pk = state.picker
      const items = pickerItems(pk)
      const restored = selKey ? items.findIndex((e) => entryKey(e) === selKey) : -1
      pk.index = restored >= 0 ? restored : Math.min(pk.index, Math.max(0, items.length - 1))
      rebuildLines()
    }))
  }

  function buildModelEntries() {
    const entries = []
    for (const p of agent.providers) {
      const active = p.name === agent.activeProvider
      const isDefaultModel = !agent.activeModel || agent.activeModel === p.model
      entries.push({ type: "header", text: p.name, note: `${p.baseURL}${p.apiKey ? "" : " (no key)"}${active ? " ← current" : ""}  loading...` })
      entries.push({ type: "item", text: p.model, action: "switch", provider: p.name, model: p.model, marker: active && isDefaultModel ? "●" : "" })
      // If a non-default model is active, show it immediately (before API fetch completes)
      if (active && agent.activeModel && agent.activeModel !== p.model) {
        entries.push({ type: "item", text: agent.activeModel, action: "switch", provider: p.name, model: agent.activeModel, marker: "●" })
      }
    }
    entries.push({ type: "header", text: "Provider Management" })
    entries.push({ type: "item", text: "Add provider…", action: "add" })
    if (agent.providers.length > 1) entries.push({ type: "item", text: "Remove provider…", action: "remove" })
    entries.push({ type: "item", text: "Set / change API key…", action: "key" })
    return entries
  }

  async function selectModel(item) {
    closePicker()
    const target = agent.providers.find((pp) => pp.name === item.provider)
    if (!target) return
    const providerDefault = target.model
    target.model = item.model
    agent.activeProvider = item.provider
    // If selecting the provider's default model, clear activeModel; otherwise set it
    agent.activeModel = item.model !== providerDefault ? item.model : null
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
    await persistRaw((raw) => {
      // 落盘前剥离运行时注入的 proxyUri（由 loadConfig + injectProxy 在加载时重建）
      raw.providers = agent.providers.map(({ proxyUri: _, ...p }) => p)
      raw.activeProvider = item.provider
      raw.activeModel = agent.activeModel || undefined  // null → omit from config
    })
    agent.config.activeProvider = item.provider
    agent.config.activeModel = agent.activeModel
    if (!agent.provider.apiKey) {
      const selKey = await askQuestion(`Enter API key for ${item.provider} (leave empty to skip):`)
      if (selKey) await setProviderKey(item.provider, selKey)
    }
  }

  async function addProviderFlow() {
    const entries = [
      { type: "header", text: "Select a preset provider" },
      ...Object.entries(PRESETS).filter(([name]) => !agent.providers.some((p) => p.name === name))
        .map(([name, p]) => ({ type: "item", text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`, name, kind: "preset" })),
      { type: "header", text: "Other" },
      { type: "item", text: "Custom (manual config)", name: "__custom__", kind: "custom" },
    ]
    const se = await showPicker("Add Provider", entries)
    if (!se) return // Esc → 返回上级（openModelPicker 循环会重开主菜单）
    if (se.kind === "custom") {
      const name = await askQuestion("Enter provider name:")
      if (!name) return
      if (agent.providers.some((p) => p.name === name)) return
      const baseURL = (await askQuestion("Enter baseURL:")).replace(/\/+$/, "")
      if (!baseURL) return
      const model = await askQuestion("Enter model name:")
      if (!model) return
      agent.providers.push({ name, baseURL, model })
      await persistRaw((raw) => { raw.providers = agent.providers })
      const key = await askQuestion(`Enter API key for ${name} (skip if none):`)
      if (key) await setProviderKey(name, key)
      return
    }
    const preset = PRESETS[se.name]
    if (!preset || agent.providers.some((p) => p.name === se.name)) return
    const cfg = { name: se.name, baseURL: preset.baseURL, model: preset.model }
    if (preset.thinking) cfg.thinking = preset.thinking
    if (preset.reasoningEffort) cfg.reasoningEffort = preset.reasoningEffort
    if (preset.maxTokens) cfg.maxTokens = preset.maxTokens
    if (preset.chatPath) cfg.chatPath = preset.chatPath
    agent.providers.push(cfg)
    await persistRaw((raw) => { raw.providers = agent.providers })
    const key = await askQuestion(`Enter API key for ${se.name} (skip if none):`)
    if (key) await setProviderKey(se.name, key)
  }

  async function removeProviderFlow() {
    const candidates = agent.providers.filter((p) => p.name !== agent.activeProvider)
    if (!candidates.length) return
    const se = await showPicker("Remove Provider", [
      { type: "header", text: "Select provider to remove" },
      ...candidates.map((p) => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
    ])
    if (!se) return
    agent.providers.splice(agent.providers.findIndex((p) => p.name === se.name), 1)
    await persistRaw((raw) => { raw.providers = agent.providers })
  }

  async function setKeyFlow() {
    const se = await showPicker("Configure API Key", [
      { type: "header", text: "Select provider" },
      ...agent.providers.map((p) => ({ type: "item", text: `${p.name} ${p.apiKey ? `(has key: ${maskKey(p.apiKey)})` : "(no key)"}`, name: p.name })),
    ])
    if (!se) return
    const key = await askQuestion(`Enter API key for ${se.name}:`)
    if (key) await setProviderKey(se.name, key)
  }

  async function setProviderKey(name, key) {
    const target = agent.providers.find((p) => p.name === name)
    if (!target) return
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw((raw) => { raw.providers = agent.providers })
  }

  return { showPicker, closePicker, popPicker, renderPickerLines, openModelPicker, selectModel, setProviderKey }
}
