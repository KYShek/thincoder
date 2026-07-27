import { sliceByWidth } from "./render.mjs"

/** 通用列表选择器 + 模型选择器。
 *  从 index.mjs 抽取，通过 createPickers(ctx) 接收闭包依赖，
 *  返回 { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey }。
 *  selectModel / pickerItems 仅内部使用，不对外暴露。 */
export function createPickers(ctx) {
  const { agent, state, render, ansi, C, pushLine, pushLabel, persistRaw, askQuestion } = ctx

  const pickerItems = () => state.picker?.entries.filter((e) => e.type === "item") ?? []

  /** 打开通用列表选择器。entries 含 { type: "header"|"item", text, note?, ...extra }，
   *  onSelect 拿到选中条目 (含 extra 字段透传），onCancel 在 Esc 时调。 */
  function openPicker({ title, entries, onSelect, onCancel, defaultIndex = 0 }) {
    state.picker = { title, entries, lines: [], index: defaultIndex, scroll: 0, selectedLine: 0, onSelect, onCancel }
    renderPickerLines()
  }

  function closePicker() {
    state.picker?.onCancel?.()
    state.picker = null
    render()
  }

  /** 按 entries 重建显示行并刷新 */
  function renderPickerLines() {
    const p = state.picker
    if (!p) return
    const lines = []
    let row = 0
    let selectedLine = 0
    for (const e of p.entries) {
      if (e.type === "header") {
        lines.push({ text: ` ${e.text}${e.note ? `  ${e.note}` : ""}`, color: ansi.bold + C.tool })
      } else {
        const selected = row === p.index
        if (selected) selectedLine = lines.length
        const marker = e.marker ? `  ${e.marker}` : ""
        lines.push({
          text: `${selected ? " ▸ " : "   "}${e.text}${marker}`,
          color: selected ? ansi.bold + C.text : C.dim,
        })
        row++
      }
    }
    p.lines = lines
    p.selectedLine = selectedLine
    render()
  }

  // ========== 模型选择器 (基于通用 picker，异步拉取远端模型列表） ==========

  async function openModelPicker() {
    const entries = []
    for (const p of agent.providers) {
      entries.push({ type: "header", text: p.name, note: `${p.baseURL}${p.apiKey ? "" : " (no key)"}  loading...` })
      entries.push({ type: "item", text: p.model, provider: p.name, model: p.model })
    }
    const onSelect = (e) => selectModel(e).catch((err) => pushLine(`[error] ${err.message}`, C.error))
    openPicker({ title: "Select Model", entries, onSelect })
    // 默认选中current在用的模型
    const current = pickerItems().findIndex(
      (e) => e.provider === agent.activeProvider && e.model === agent.provider.model,
    )
    if (current >= 0) state.picker.index = current
    renderPickerLines()

    const { listModels } = await import("../provider/index.mjs")
    await Promise.all(
      agent.providers.map(async (p) => {
        const header = entries.find((e) => e.type === "header" && e.provider === undefined && e.text === p.name)
        const noteBase = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
        try {
          const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
          let apiKey = p.apiKey
          if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
          if (!apiKey) apiKey = process.env.THINCODER_API_KEY
          const models = await listModels(
            { baseURL: p.baseURL, apiKey: apiKey ?? "" },
            { signal: AbortSignal.timeout(10000) },
          )
          const at = entries.findIndex((e) => e.type === "item" && e.provider === p.name && e.model === p.model)
          entries.splice(
            at + 1,
            0,
            ...models.filter((m) => m !== p.model).map((m) => ({ type: "item", text: m, provider: p.name, model: m })),
          )
          if (header) header.note = noteBase
        } catch (error) {
          if (header) header.note = `${noteBase}   (fetch failed: ${sliceByWidth(error.message, 60)}）`
        }
        if (state.picker?.entries === entries) renderPickerLines()
      }),
    )
  }

  /** 给指定 provider 写 key (内存 + Config文件）；若它是current激活的，同步运行时 */
  async function setProviderKey(name, key) {
    const target = agent.providers.find((p) => p.name === name)
    if (!target) {
      pushLine(`Provider "${name}"`, C.error)
      return
    }
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw((raw) => { raw.providers = agent.providers })
    pushLabel(`❯ Provider`, ansi.bold + C.tool)
    pushLine(`API key saved to ${name}`, C.tool)
  }

  /** 选中：切换 provider + 模型，持久化，阈值随模型走 */
  async function selectModel(item) {
    closePicker()
    const target = agent.providers.find((pp) => pp.name === item.provider)
    if (!target) return
    target.model = item.model
    agent.activeProvider = item.provider
    agent.provider = { ...target }
    if (!agent.provider.apiKey) {
      const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[item.provider]
      if (envKey && process.env[envKey]) agent.provider.apiKey = process.env[envKey]
    }
    if (!agent.provider.apiKey) agent.provider.apiKey = process.env.THINCODER_API_KEY
    let thresholdNote = ""
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("../config.mjs")
      const { value } = resolveCompactThreshold(null, item.model)
      agent.config.agent.compactThreshold = value
      thresholdNote = `, compact threshold adjusted to ${value}`
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = item.provider
    })
    agent.config.activeProvider = item.provider
    pushLabel(`❯ Model`, ansi.bold + C.tool)
    pushLine(`Switched to ${item.provider} / ${item.model}${thresholdNote} (persisted)`, C.tool)
    if (!agent.provider.apiKey) {
      pushLine(`Provider has no key`, C.warn)
      const selKey = await askQuestion(`Enter API key for ${item.provider} (leave empty to skip):`)
      if (selKey) {
        await setProviderKey(item.provider, selKey)
      } else {
        pushLine(`Skipped. Configure later via /provider → Set API Key`, C.dim)
      }
    }
  }

  return { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey }
}
