import { sliceByWidth } from "./render.mjs"
import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"

/** 通用列表选择器 + 统一模型/provider 管理 picker。
 *  通过 createPickers(ctx) 接收闭包依赖，
 *  返回 { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey }。 */
export function createPickers(ctx) {
  const { agent, state, render, ansi, C, pushLine, persistRaw, askQuestion, maskKey } = ctx

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

  // ========== 统一 picker：模型切换 + provider 管理 ==========

  async function openModelPicker() {
    const entries = buildModelEntries()
    const onSelect = async (e) => {
      if (e.action === "switch") {
        await selectModel(e).catch((err) => pushLine(`[error] ${err.message}`, C.error))
      } else if (e.action === "add") {
        await addProviderFlow()
      } else if (e.action === "remove") {
        await removeProviderFlow()
      } else if (e.action === "key") {
        await setKeyFlow()
      }
    }
    openPicker({ title: "Models & Providers", entries, onSelect })
    // 默认选中当前在用的模型
    const current = pickerItems().findIndex(
      (e) => e.action === "switch" && e.provider === agent.activeProvider && e.model === agent.provider.model,
    )
    if (current >= 0) state.picker.index = current
    renderPickerLines()

    // 异步拉取远端模型列表，追加到对应 provider 下
    const { listModels } = await import("../provider/index.mjs")
    await Promise.all(
      agent.providers.map(async (p) => {
        try {
          const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
          let apiKey = p.apiKey
          if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
          if (!apiKey) apiKey = process.env.THINCODER_API_KEY
          const models = await listModels(
            { baseURL: p.baseURL, apiKey: apiKey ?? "" },
            { signal: AbortSignal.timeout(10000) },
          )
          // 找到当前 provider 在 entries 里的模型 item 位置，在其后插入新模型
          const at = entries.findLastIndex(
            (e) => e.type === "item" && e.action === "switch" && e.provider === p.name,
          )
          if (at >= 0) {
            entries.splice(
              at + 1,
              0,
              ...models
                .filter((m) => m !== p.model)
                .map((m) => ({ type: "item", text: m, action: "switch", provider: p.name, model: m })),
            )
          }
          // 更新 header note 去掉 loading
          const header = entries.find((e) => e.type === "header" && e.text === p.name)
          if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
        } catch (error) {
          const header = entries.find((e) => e.type === "header" && e.text === p.name)
          if (header) header.note = `${p.baseURL}${p.apiKey ? "" : " (no key)"}  (fetch failed: ${sliceByWidth(error.message, 40)})`
        }
        if (state.picker?.entries === entries) renderPickerLines()
      }),
    )
  }

  /** 构建 picker entries：每个 provider 一个 header + 模型列表，底部是管理操作 */
  function buildModelEntries() {
    const entries = []
    for (const p of agent.providers) {
      const active = p.name === agent.activeProvider
      entries.push({
        type: "header",
        text: p.name,
        note: `${p.baseURL}${p.apiKey ? "" : " (no key)"}${active ? " ← current" : ""}  loading...`,
      })
      entries.push({
        type: "item",
        text: p.model,
        action: "switch",
        provider: p.name,
        model: p.model,
        marker: active ? "●" : "",
      })
    }
    // 管理操作
    entries.push({ type: "header", text: "Provider Management" })
    entries.push({ type: "item", text: "Add provider…", action: "add" })
    if (agent.providers.length > 1) {
      entries.push({ type: "item", text: "Remove provider…", action: "remove" })
    }
    entries.push({ type: "item", text: "Set / change API key…", action: "key" })
    return entries
  }

  /** 切换 provider + 模型，持久化，阈值随模型走 */
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
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("../config.mjs")
      const { value } = resolveCompactThreshold(null, item.model)
      agent.config.agent.compactThreshold = value
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = item.provider
    })
    agent.config.activeProvider = item.provider
    if (!agent.provider.apiKey) {
      const selKey = await askQuestion(`Enter API key for ${item.provider} (leave empty to skip):`)
      if (selKey) await setProviderKey(item.provider, selKey)
    }
  }

  /** 添加 provider：预设菜单 → 输入 key → 完成，或自定义逐项输入 */
  async function addProviderFlow() {
    const presetEntries = [
      { type: "header", text: "Select a preset provider" },
      ...Object.entries(PRESETS)
        .filter(([name]) => !agent.providers.some((p) => p.name === name))
        .map(([name, p]) => ({
          type: "item",
          text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`,
          name,
          kind: "preset",
        })),
      { type: "header", text: "Other" },
      { type: "item", text: "Custom (manual config)", name: "__custom__", kind: "custom" },
    ]
    openPicker({
      title: "Add Provider",
      entries: presetEntries,
      onCancel: () => openModelPicker().catch(() => {}),
      onSelect: async (se) => {
        if (se.kind === "custom") {
          const name = await askQuestion("Enter provider name:")
          if (!name) { openModelPicker().catch(() => {}); return }
          if (agent.providers.some((p) => p.name === name)) { openModelPicker().catch(() => {}); return }
          const baseURLRaw = await askQuestion("Enter baseURL (e.g. https://api.example.com/v1):")
          if (!baseURLRaw) { openModelPicker().catch(() => {}); return }
          const baseURL = baseURLRaw.replace(/\/+$/, "")
          if (!/^https?:\/\//.test(baseURL)) { openModelPicker().catch(() => {}); return }
          const model = await askQuestion("Enter model name:")
          if (!model) { openModelPicker().catch(() => {}); return }
          agent.providers.push({ name, baseURL, model })
          await persistRaw((raw) => { raw.providers = agent.providers })
          const key = await askQuestion(`Enter API key for ${name} (leave empty to skip):`)
          if (key) { await setProviderKey(name, key) }
          openModelPicker().catch(() => {})
          return
        }
        // 预设
        if (agent.providers.some((p) => p.name === se.name)) { openModelPicker().catch(() => {}); return }
        const preset = PRESETS[se.name]
        const providerCfg = { name: se.name, baseURL: preset.baseURL, model: preset.model }
        if (preset.thinking) providerCfg.thinking = preset.thinking
        if (preset.reasoningEffort) providerCfg.reasoningEffort = preset.reasoningEffort
        if (preset.maxTokens) providerCfg.maxTokens = preset.maxTokens
        if (preset.chatPath) providerCfg.chatPath = preset.chatPath
        if (preset.desc) providerCfg.desc = preset.desc
        agent.providers.push(providerCfg)
        await persistRaw((raw) => { raw.providers = agent.providers })
        const presetKey = await askQuestion(`Enter API key for ${se.name} (leave empty to skip):`)
        if (presetKey) await setProviderKey(se.name, presetKey)
        openModelPicker().catch(() => {})
      },
    })
  }

  /** 删除 provider（不能删当前激活的） */
  async function removeProviderFlow() {
    const candidates = agent.providers.filter((p) => p.name !== agent.activeProvider)
    if (candidates.length === 0) { openModelPicker().catch(() => {}); return }
    const removeEntries = [
      { type: "header", text: "Select provider to remove (current one cannot be removed)" },
      ...candidates.map((p) => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
    ]
    openPicker({
      title: "Remove Provider",
      entries: removeEntries,
      onCancel: () => openModelPicker().catch(() => {}),
      onSelect: async (se) => {
        const at = agent.providers.findIndex((p) => p.name === se.name)
        agent.providers.splice(at, 1)
        await persistRaw((raw) => { raw.providers = agent.providers })
        openModelPicker().catch(() => {})
      },
    })
  }

  /** 设置/更改 API key：选 provider → 输入 key */
  async function setKeyFlow() {
    const keyEntries = [
      { type: "header", text: "Select provider to configure key" },
      ...agent.providers.map((p) => ({
        type: "item",
        text: `${p.name} ${p.apiKey ? `(has key: ${maskKey(p.apiKey)})` : "(no key)"}`,
        name: p.name,
      })),
    ]
    openPicker({
      title: "Configure API Key",
      entries: keyEntries,
      onCancel: () => openModelPicker().catch(() => {}),
      onSelect: async (se) => {
        const key = await askQuestion(`Enter API key for ${se.name}:`)
        if (!key) { openModelPicker().catch(() => {}); return }
        await setProviderKey(se.name, key)
        openModelPicker().catch(() => {})
      },
    })
  }

  /** 给指定 provider 写 key (内存 + Config文件）；若它是current激活的，同步运行时 */
  async function setProviderKey(name, key) {
    const target = agent.providers.find((p) => p.name === name)
    if (!target) return
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw((raw) => { raw.providers = agent.providers })
  }

  return { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey }
}
