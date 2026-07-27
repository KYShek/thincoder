import { existsSync, readFileSync } from "node:fs"
import { ansi, C } from "./ansi.mjs"

/** /config command: set embedding key / advanced path=value config.
 *  Extracted from slash-commands.mjs.
 *  ctx: { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey, ansi, C } */
export async function handleConfigCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, maskKey } = ctx
  const { configPath } = await import("../config.mjs")
  const cp = configPath
  const ac = agent.config?.agent ?? {}
  const entries = [
    { type: "header", text: "Current config" },
    { type: "item", text: "Set embedding key (vector search)", action: "embedkey" },
    { type: "item", text: "Advanced (set path value)", action: "set" },
  ]
  openPicker({
    title: "Config",
    entries,
    onSelect: async (e) => {
      if (e.action === "view") {
        pushLabel(`❯ Config`, ansi.bold + C.tool)
        pushLine(`Active: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
        pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
        const tn = `${ac.compactThreshold ?? 100000}${ac.compactThresholdAuto ? " (auto)" : ""}`
        pushLine(`agent:  maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${tn}`, C.dim)
        pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${agent.config?.embedding?.model ?? ""})` : "disabled (FTS only)"}`, C.dim)
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
      if (e.action === "set") {
        const settext = await askQuestion("Enter: <path> <value> (e.g. agent.maxTurns 80, supports a.b nesting):")
        if (!settext) return
        const parts = settext.split(/\s+/)
        const [path, value] = [parts[0], parts.slice(1).join(" ")]
        if (!path || !value) { pushLine("Usage: <path> <value>  e.g. agent.maxTurns 80", C.error); return }
        try {
          const { configPath, loadConfig, saveConfig } = await import("../config.mjs")
          const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
          const keys = path.split(".")
          let obj = raw
          for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] ??= {}; obj = obj[keys[i]] }
          obj[keys[keys.length - 1]] = isNaN(value) ? value : Number(value)
          saveConfig(raw)
          const cfg = loadConfig()
          agent.provider = cfg.provider
          agent.providers = cfg.providersList
          agent.activeProvider = cfg.activeProvider
          agent.config = cfg
          pushLabel(`❯ Config`, ansi.bold + C.tool)
          pushLine(`Saved: ${path} = ${value}`, C.tool)
        } catch (error) {
          pushLine(`Save failed: ${error.message}`, C.error)
        }
      }
    },
  })
}
