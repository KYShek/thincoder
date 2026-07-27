import { existsSync, readFileSync } from "node:fs"
import { ansi, C } from "./ansi.mjs"

/** /config command: view and set agent/embedding config.
 *  Extracted from slash-commands.mjs.
 *  ctx: { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey, ansi, C } */
export async function handleConfigCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey } = ctx
  const { configPath } = await import("../config.mjs")
  const ac = agent.config?.agent ?? {}
  const ec = agent.config?.embedding ?? {}

  function cfgSummary() {
    const tn = `${ac.compactThreshold ?? 100000}${agent.config?.agent?.compactThresholdAuto ? " (auto)" : ""}`
    const vg = ac.verifyGuard === true ? "on" : "off"
    return `agent.maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${tn} | verifyGuard=${vg} | embedding=${agent.memory?.embedder ? "on" : "off"}`
  }

  const mainEntries = [
    { type: "header", text: `Config: ${cfgSummary()}` },
    { type: "item", text: `agent.maxTurns = ${ac.maxTurns ?? 100}`, action: "agent.maxTurns" },
    { type: "item", text: `agent.subagentTurns = ${ac.subagentTurns ?? 100}`, action: "agent.subagentTurns" },
    { type: "item", text: `agent.compactThreshold = ${ac.compactThreshold ?? 100000}${agent.config?.agent?.compactThresholdAuto ? " (auto)" : ""}`, action: "agent.compactThreshold" },
    { type: "item", text: `agent.verifyGuard = ${ac.verifyGuard === true ? "on" : "off"}`, action: "agent.verifyGuard" },
    { type: "item", text: "Set embedding API key", action: "embedkey" },
    { type: "item", text: `embedding.model = ${ec.model ?? "BAAI/bge-m3"}`, action: "embedding.model" },
    { type: "item", text: "View full config", action: "view" },
  ]

  openPicker({
    title: "Config",
    entries: mainEntries,
    onSelect: async (e) => {
      if (e.action === "view") {
        const cp = configPath
        pushLabel(`❯ Config`, ansi.bold + C.tool)
        pushLine(`Active: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
        pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
        pushLine(`agent.maxTurns: ${ac.maxTurns ?? 100}`, C.dim)
        pushLine(`agent.subagentTurns: ${ac.subagentTurns ?? 100}`, C.dim)
        pushLine(`agent.compactThreshold: ${ac.compactThreshold ?? 100000}${agent.config?.agent?.compactThresholdAuto ? " (auto)" : ""}`, C.dim)
        pushLine(`agent.verifyGuard: ${ac.verifyGuard === true ? "on" : "off"}`, C.dim)
        pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${ec.model ?? ""})` : "disabled (FTS only)"}`, C.dim)
        pushLine(`Config file: ${cp}`, C.dim)
        return
      }
      if (e.action === "embedkey") {
        const embKey = await askQuestion("Enter embedding API key (default: SiliconFlow bge-m3):")
        if (!embKey) return
        agent.config.embedding ??= {}
        agent.config.embedding.apiKey = embKey
        await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: embKey } })
        if (agent.memory) {
          const { createEmbedder } = await import("../embedding.mjs")
          agent.memory.embedder = createEmbedder(agent.config.embedding)
        }
        pushLabel(`❯ Config`, ansi.bold + C.tool)
        pushLine(`Embedding key saved, vector search enabled`, C.tool)
        return
      }
      // Boolean toggle: agent.verifyGuard
      if (e.action === "agent.verifyGuard") {
        const newVal = ac.verifyGuard !== true // toggle: undefined/false → true, true → false
        try {
          const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
          raw.agent ??= {}
          raw.agent.verifyGuard = newVal
          const { saveConfig, loadConfig } = await import("../config.mjs")
          saveConfig(raw)
          const cfg = loadConfig()
          agent.provider = cfg.provider
          agent.providers = cfg.providersList
          agent.activeProvider = cfg.activeProvider
          agent.config = cfg
          agent.config.agent ??= {}
          pushLabel(`❯ Config`, ansi.bold + C.tool)
          pushLine(`agent.verifyGuard = ${newVal ? "on" : "off"}`, C.tool)
        } catch (error) {
          pushLine(`Save failed: ${error.message}`, C.error)
        }
        return
      }
      // embedding.model picker
      if (e.action === "embedding.model") {
        const models = [
          { label: "BAAI/bge-m3 (multilingual, 1024d)", value: "BAAI/bge-m3" },
          { label: "BAAI/bge-large-zh-v1.5 (Chinese, 1024d)", value: "BAAI/bge-large-zh-v1.5" },
          { label: "BAAI/bge-large-en-v1.5 (English, 1024d)", value: "BAAI/bge-large-en-v1.5" },
          { label: "text-embedding-3-small (OpenAI, 1536d)", value: "text-embedding-3-small" },
          { label: "text-embedding-3-large (OpenAI, 3072d)", value: "text-embedding-3-large" },
        ]
        const currentVal = ec.model ?? "BAAI/bge-m3"
        openPicker({
          title: `Embedding model (current: ${currentVal})`,
          entries: [
            { type: "header", text: `Current: ${currentVal}` },
            ...models.map((m) => ({ type: "item", text: m.label, action: m.value })),
          ],
          onSelect: async (sel) => {
            try {
              const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
              raw.embedding ??= {}
              raw.embedding.model = sel.action
              const { saveConfig, loadConfig } = await import("../config.mjs")
              saveConfig(raw)
              const cfg = loadConfig()
              agent.provider = cfg.provider
              agent.providers = cfg.providersList
              agent.activeProvider = cfg.activeProvider
              agent.config = cfg
              agent.config.agent ??= {}
              pushLabel(`❯ Config`, ansi.bold + C.tool)
              pushLine(`embedding.model = ${sel.action}`, C.tool)
            } catch (error) {
              pushLine(`Save failed: ${error.message}`, C.error)
            }
          },
        })
        return
      }
      // Numeric config items: ask for value, parse as number
      const isNumeric = e.action.startsWith("agent.")
      const label = e.action
      const current = e.action === "agent.maxTurns" ? (ac.maxTurns ?? 100)
        : e.action === "agent.subagentTurns" ? (ac.subagentTurns ?? 100)
        : e.action === "agent.compactThreshold" ? (ac.compactThreshold ?? 100000)
        : ""
      const prompt = `${label} (current: ${current}):`
      const val = await askQuestion(prompt)
      if (!val) return
      try {
        const { configPath, loadConfig, saveConfig } = await import("../config.mjs")
        const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
        if (isNumeric) {
          const keys = label.split(".")
          let obj = raw
          for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] ??= {}; obj = obj[keys[i]] }
          const num = Number(val)
          if (isNaN(num)) { pushLine("Value must be a number", C.error); return }
          obj[keys[keys.length - 1]] = num
        }
        saveConfig(raw)
        const cfg = loadConfig()
        agent.provider = cfg.provider
        agent.providers = cfg.providersList
        agent.activeProvider = cfg.activeProvider
        agent.config = cfg
        agent.config.agent ??= {}
        pushLabel(`❯ Config`, ansi.bold + C.tool)
        pushLine(`${label} = ${val}`, C.tool)
        pushLine("(restart to apply to existing agent state)", C.dim)
      } catch (error) {
        pushLine(`Save failed: ${error.message}`, C.error)
      }
    },
  })
}
