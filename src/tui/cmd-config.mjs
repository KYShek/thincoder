import { existsSync, readFileSync } from "node:fs"
import { ansi, C } from "./ansi.mjs"

/** /config command: view and set agent/embedding/proxy config. */
export async function handleConfigCommand(ctx) {
  const { agent, pushLine, pushLabel, showPicker, askQuestion, persistRaw, maskKey } = ctx
  const { configPath } = await import("../config.mjs")
  const ac = agent.config?.agent ?? {}
  const ec = agent.config?.embedding ?? {}
  const pc = agent.config?.proxy

  function proxySummary() {
    if (!pc) return "not configured"
    const uri = typeof pc === "string" ? pc : (pc.uri || pc.url || "")
    const web = typeof pc === "object" ? (pc.web !== false) : true
    return `${uri || "(no uri)"} web:${web ? "on" : "off"}`
  }

  // ── Main config loop ──
  let running = true
  while (running) {
    const mainEntries = [
      { type: "header", text: `proxy=${proxySummary()} | maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${ac.compactThreshold ?? 100000} | verifyGuard=${ac.verifyGuard === true ? "on" : "off"} | embedding=${agent.memory?.embedder ? "on" : "off"}` },
      { type: "item", text: `agent.maxTurns = ${ac.maxTurns ?? 100}`, action: "agent.maxTurns" },
      { type: "item", text: `agent.subagentTurns = ${ac.subagentTurns ?? 100}`, action: "agent.subagentTurns" },
      { type: "item", text: `agent.compactThreshold = ${ac.compactThreshold ?? 100000}${agent.config?.agent?.compactThresholdAuto ? " (auto)" : ""}`, action: "agent.compactThreshold" },
      { type: "item", text: `agent.verifyGuard = ${ac.verifyGuard === true ? "on" : "off"}`, action: "agent.verifyGuard" },
      { type: "item", text: "Set embedding API key", action: "embedkey" },
      { type: "item", text: `embedding.model = ${ec.model ?? "BAAI/bge-m3"}`, action: "embedding.model" },
      { type: "item", text: `proxy = ${proxySummary()}`, action: "proxy" },
      { type: "item", text: "View full config", action: "view" },
    ]

    const choice = await showPicker("Config", mainEntries)
    if (!choice) { running = false; continue } // Esc

    if (choice.action === "view") {
      pushLabel("❯ Config", ansi.bold + C.tool)
      pushLine(`Active: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
      pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
      pushLine(`agent.maxTurns: ${ac.maxTurns ?? 100}`, C.dim)
      pushLine(`agent.subagentTurns: ${ac.subagentTurns ?? 100}`, C.dim)
      pushLine(`agent.compactThreshold: ${ac.compactThreshold ?? 100000}${agent.config?.agent?.compactThresholdAuto ? " (auto)" : ""}`, C.dim)
      pushLine(`agent.verifyGuard: ${ac.verifyGuard === true ? "on" : "off"}`, C.dim)
      pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${ec.model ?? ""})` : "disabled (FTS only)"}`, C.dim)
      pushLine(`proxy: ${proxySummary()}`, C.dim)
      pushLine(`Config file: ${configPath}`, C.dim)
      running = false
      continue
    }

    if (choice.action === "proxy") {
      // Proxy sub-menu loop
      let proxyRunning = true
      while (proxyRunning) {
        const curProxy = agent.config?.proxy
        const uri = typeof curProxy === "string" ? curProxy : (curProxy?.uri || curProxy?.url || "")
        const webOn = typeof curProxy === "object" ? (curProxy.web !== false) : true
        const proxyEntries = [
          { type: "header", text: `Proxy: ${uri || "(not set)"} | web: ${webOn ? "on" : "off"}` },
          { type: "item", text: `Set proxy URI ${uri ? `(current: ${uri})` : ""}`, action: "seturi" },
          { type: "item", text: `Web tools (fetch/websearch): ${webOn ? "ON" : "OFF"}`, action: "toggleweb" },
          { type: "item", text: "Clear proxy", action: "clear" },
        ]
        const proxyChoice = await showPicker("Proxy", proxyEntries)
        if (!proxyChoice) { proxyRunning = false; continue } // Esc back to main

        try {
          const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
          if (proxyChoice.action === "seturi") {
            const newUri = await askQuestion("Proxy URI (e.g. http://127.0.0.1:7890):")
            if (!newUri) continue
            raw.proxy = typeof raw.proxy === "object" ? { ...raw.proxy, uri: newUri } : { uri: newUri, web: true }
          } else if (proxyChoice.action === "toggleweb") {
            const cur = raw.proxy
            const cw = typeof cur === "object" ? (cur.web !== false) : true
            raw.proxy = typeof cur === "object" ? { ...cur, web: !cw } : { uri: typeof cur === "string" ? cur : "", web: !cw }
          } else if (proxyChoice.action === "clear") {
            delete raw.proxy
          }
          const { saveConfig, loadConfig } = await import("../config.mjs")
          saveConfig(raw)
          const cfg = loadConfig()
          agent.provider = cfg.provider
          agent.providers = cfg.providersList
          agent.activeProvider = cfg.activeProvider
          agent.config = cfg
          agent.config.agent ??= {}
          pushLabel("❯ Config", ansi.bold + C.tool)
          pushLine("Proxy updated", C.tool)
          proxyRunning = false
        } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
      }
      continue
    }

    if (choice.action === "embedkey") {
      const embKey = await askQuestion("Enter embedding API key (default: SiliconFlow bge-m3):")
      if (!embKey) continue
      agent.config.embedding ??= {}
      agent.config.embedding.apiKey = embKey
      await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: embKey } })
      if (agent.memory) {
        const { createEmbedder } = await import("../embedding.mjs")
        agent.memory.embedder = createEmbedder(agent.config.embedding)
      }
      pushLabel("❯ Config", ansi.bold + C.tool)
      pushLine("Embedding key saved, vector search enabled", C.tool)
      running = false
      continue
    }

    if (choice.action === "agent.verifyGuard") {
      const newVal = ac.verifyGuard !== true
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
        pushLabel("❯ Config", ansi.bold + C.tool)
        pushLine(`agent.verifyGuard = ${newVal ? "on" : "off"}`, C.tool)
        running = false
      } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
      continue
    }

    if (choice.action === "embedding.model") {
      const models = [
        { label: "BAAI/bge-m3 (multilingual, 1024d)", value: "BAAI/bge-m3" },
        { label: "BAAI/bge-large-zh-v1.5 (Chinese, 1024d)", value: "BAAI/bge-large-zh-v1.5" },
        { label: "BAAI/bge-large-en-v1.5 (English, 1024d)", value: "BAAI/bge-large-en-v1.5" },
        { label: "text-embedding-3-small (OpenAI, 1536d)", value: "text-embedding-3-small" },
        { label: "text-embedding-3-large (OpenAI, 3072d)", value: "text-embedding-3-large" },
      ]
      const currentVal = ec.model ?? "BAAI/bge-m3"
      const modelChoice = await showPicker("Embedding Model", [
        { type: "header", text: `Current: ${currentVal}` },
        ...models.map(m => ({ type: "item", text: m.label, action: m.value })),
      ])
      if (!modelChoice) continue
      try {
        const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
        raw.embedding ??= {}
        raw.embedding.model = modelChoice.action
        const { saveConfig, loadConfig } = await import("../config.mjs")
        saveConfig(raw)
        const cfg = loadConfig()
        agent.provider = cfg.provider
        agent.providers = cfg.providersList
        agent.activeProvider = cfg.activeProvider
        agent.config = cfg
        agent.config.agent ??= {}
        pushLabel("❯ Config", ansi.bold + C.tool)
        pushLine(`embedding.model = ${modelChoice.action}`, C.tool)
        running = false
      } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
      continue
    }

    // Numeric config items
    const label = choice.action
    const current = label === "agent.maxTurns" ? (ac.maxTurns ?? 100)
      : label === "agent.subagentTurns" ? (ac.subagentTurns ?? 100)
      : label === "agent.compactThreshold" ? (ac.compactThreshold ?? 100000)
      : ""
    const val = await askQuestion(`${label} (current: ${current}):`)
    if (!val) continue
    try {
      const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
      const keys = label.split(".")
      let obj = raw
      for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] ??= {}; obj = obj[keys[i]] }
      const num = Number(val)
      if (isNaN(num)) { pushLine("Value must be a number", C.error); continue }
      obj[keys[keys.length - 1]] = num
      const { saveConfig, loadConfig } = await import("../config.mjs")
      saveConfig(raw)
      const cfg = loadConfig()
      agent.provider = cfg.provider
      agent.providers = cfg.providersList
      agent.activeProvider = cfg.activeProvider
      agent.config = cfg
      agent.config.agent ??= {}
      pushLabel("❯ Config", ansi.bold + C.tool)
      pushLine(`${label} = ${val}`, C.tool)
      pushLine("(restart to apply)", C.dim)
      running = false
    } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
  }
}
