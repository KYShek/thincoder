import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"
import { ansi, C } from "./ansi.mjs"

/** /provider 命令处理器：查看/添加/删除 provider、设置 API key。
 *  从 slash-commands.mjs 抽出，通过 ctx 接收闭包依赖。
 *  ctx: { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey, setProviderKey } */
export async function handleProviderCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey, setProviderKey } = ctx
  const entries = [
    { type: "header", text: `${agent.providers.length} providers` },
    { type: "item", text: "View list", action: "list" },
    { type: "item", text: "Add provider", action: "add" },
  ]
  if (agent.providers.length > 1) {
    entries.push({ type: "item", text: "Remove provider", action: "remove" })
  }
  if (!agent.provider.apiKey) {
    entries.push({ type: "item", text: "Set API Key", action: "key" })
  } else {
    entries.push({ type: "item", text: "Change API Key", action: "key" })
  }
  openPicker({
    title: "Providers",
    entries,
    onSelect: async (e) => {
      if (e.action === "list") {
        pushLabel(`❯ Providers (${agent.providers.length})`, ansi.bold + C.tool)
        for (const p of agent.providers) {
          const active = p.name === agent.activeProvider
          pushLine(
            `${active ? " ▸" : "  "} ${p.name.padEnd(12)} ${p.model.padEnd(20)} ${p.baseURL}${p.apiKey ? " ●key" : " ○nonekey"}${active ? " ← current" : ""}`,
            active ? C.tool : C.dim,
          )
        }
        return
      }
      if (e.action === "remove") {
        const candidates = agent.providers.filter((p) => p.name !== agent.activeProvider)
        if (candidates.length === 0) {
          pushLine("Cannot remove current provider (switch to another with /model first)", C.warn)
          return
        }
        const removeEntries = [
          { type: "header", text: "Select provider to remove (current one cannot be removed)" },
          ...candidates.map((p) => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
        ]
        openPicker({
          title: "Remove Provider",
          entries: removeEntries,
          onSelect: async (se) => {
            const at = agent.providers.findIndex((p) => p.name === se.name)
            agent.providers.splice(at, 1)
            await persistRaw((raw) => { raw.providers = agent.providers })
            pushLine(`Removed ${se.name}`, C.tool)
          },
        })
        return
      }
      if (e.action === "add") {
        // 菜单选预设 → 输 API key → 完成
        const presetEntries = [
          { type: "header", text: "Select a preset provider" },
          ...Object.entries(PRESETS).map(([name, p]) => ({
            type: "item",
            text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`,
            name,
          })),
          { type: "header", text: "Other" },
          { type: "item", text: "Custom (manual config)", name: "__custom__" },
        ]
        openPicker({
          title: "Add Provider",
          entries: presetEntries,
          onSelect: async (se) => {
            if (se.name === "__custom__") {
              // 自定义：逐项输入 name → baseURL → model → key
              const name = await askQuestion("Enter provider name:")
              if (!name) return
              if (agent.providers.some((p) => p.name === name)) {
                pushLine(`"${name}" already exists — remove it via /provider first`, C.warn)
                return
              }
              const baseURLRaw = await askQuestion("Enter baseURL (e.g. https://api.example.com/v1):")
              if (!baseURLRaw) { pushLine("Cancelled", C.dim); return }
              const baseURL = baseURLRaw.replace(/\/+$/, "")
              if (!/^https?:\/\//.test(baseURL)) { pushLine(`baseURL must start with http(s)://`, C.error); return }
              const model = await askQuestion("Enter model name:")
              if (!model) { pushLine("Cancelled", C.dim); return }
              agent.providers.push({ name, baseURL, model })
              await persistRaw((raw) => { raw.providers = agent.providers })
              pushLabel(`❯ Provider`, ansi.bold + C.tool)
              pushLine(`Added ${name} (${baseURL} / ${model})`, C.tool)
              const key = await askQuestion(`Enter API key for ${name} (leave empty to skip):`)
              if (key) { await setProviderKey(name, key); pushLine(`Key saved for ${name}`, C.tool) }
              else { pushLine(`Skipped key. Configure later via /provider → Set API Key`, C.dim) }
              return
            }
            // 预设：name/baseURL/model 全自动填
            const preset = PRESETS[se.name]
            if (agent.providers.some((p) => p.name === se.name)) {
              pushLine(`"${se.name}" already exists — remove it via /provider first`, C.warn)
              return
            }
            const providerCfg = { name: se.name, baseURL: preset.baseURL, model: preset.model }
            if (preset.thinking) providerCfg.thinking = preset.thinking
            if (preset.reasoningEffort) providerCfg.reasoningEffort = preset.reasoningEffort
            if (preset.maxTokens) providerCfg.maxTokens = preset.maxTokens
            if (preset.chatPath) providerCfg.chatPath = preset.chatPath
            if (preset.desc) providerCfg.desc = preset.desc
            agent.providers.push(providerCfg)
            await persistRaw((raw) => { raw.providers = agent.providers })
            pushLabel(`❯ Provider`, ansi.bold + C.tool)
            pushLine(`Added ${se.name} (${preset.baseURL} / ${preset.model})`, C.tool)
            // 直接接 key 输入
            const presetKey = await askQuestion(`Enter API key for ${se.name} (leave empty to skip; configure later via /provider → Set Key):`)
            if (presetKey) {
              await setProviderKey(se.name, presetKey)
              pushLine(`Key saved for ${se.name}`, C.tool)
            } else {
              pushLine(`Skipped key. Configure later via /provider → Set API Key`, C.dim)
            }
          },
        })
        return
      }
      if (e.action === "key") {
        // Key: pick which provider, then prompt for key
        const keyEntries = [
          { type: "header", text: "Select provider to configure key" },
          ...agent.providers.map((p) => ({ type: "item", text: `${p.name} ${p.apiKey ? `(has key: ${maskKey(p.apiKey)})` : "(no key)"}`, name: p.name })),
        ]
        openPicker({
          title: "Configure API Key",
          entries: keyEntries,
          onSelect: async (se) => {
            const key = await askQuestion(`Enter API key for ${se.name}:`)
            if (!key) {
              pushLine(`Skipped key entry`, C.dim)
              return
            }
            await setProviderKey(se.name, key)
          },
        })
      }
    },
  })
}
