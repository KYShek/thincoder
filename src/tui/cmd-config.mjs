import { existsSync, readFileSync } from "node:fs"
import { ansi, C } from "./ansi.mjs"

/** /config command: view and set agent/embedding/proxy config. */
export async function handleConfigCommand(ctx, args = []) {
  const { agent, pushLine, pushLabel, showPicker, askQuestion, persistRaw, maskKey } = ctx
  const { configPath } = await import("../config.mjs")
  const ac = agent.config?.agent ?? {}
  const ec = agent.config?.embedding ?? {}

  // agent.config.proxy 已被 loadConfig 归一化为 { uri, web, model } | undefined
  function proxySummary() {
    const pc = agent.config?.proxy
    if (!pc) return "not configured"
    return `${pc.uri} web:${pc.web ? "on" : "off"} model:${pc.model ? "on" : "off"}`
  }

  async function setEmbedKey() {
    const embKey = await askQuestion("Enter embedding API key (default: SiliconFlow bge-m3):")
    if (!embKey) return false
    agent.config.embedding ??= {}
    agent.config.embedding.apiKey = embKey
    await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: embKey } })
    if (agent.memory) {
      const { createEmbedder } = await import("../embedding.mjs")
      agent.memory.embedder = createEmbedder(agent.config.embedding)
    }
    pushLabel("❯ Config", ansi.bold + C.tool)
    pushLine("Embedding key saved, vector search enabled", C.tool)
    return true
  }

  /** 保存后的公共重载：loadConfig → injectProxy → 恢复 provider 选择。
   *  运行时 /model 切过 provider（未落盘）时保持它，不回滚到磁盘值。 */
  async function reloadConfig() {
    const { loadConfig } = await import("../config.mjs")
    const { injectProxy } = await import("../proxy.mjs")
    const cfg = loadConfig()
    injectProxy(cfg.providersList, cfg)
    const runtimeName = agent.activeProvider
    agent.providers = cfg.providersList
    agent.config = cfg
    agent.config.agent ??= {}
    const keep = cfg.providersList.find((p) => p.name === runtimeName)
    if (runtimeName && runtimeName !== cfg.activeProvider && keep) {
      // 运行时选择在新配置里仍存在 → 保持（provider 为注入 proxyUri 后的新对象）
      agent.activeProvider = runtimeName
      agent.provider = { ...keep }
    } else {
      agent.activeProvider = cfg.activeProvider
      agent.provider = cfg.provider
      agent.provider.proxyUri = cfg.providersList.find((p) => p.name === cfg.activeProvider)?.proxyUri
    }
  }

  /** 保存 config（mutate 改 raw）→ reloadConfig（provider 代理无需重启即生效） */
  async function saveProxy(mutate) {
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    const { saveConfig } = await import("../config.mjs")
    saveConfig(raw)
    await reloadConfig()
  }

  // ── Proxy sub-menu loop：每轮重建 entries 显示最新状态，defaultIndex 记住上次位置 ──
  async function proxyMenu() {
    let proxyIdx = 0
    for (;;) {
      const pc = agent.config?.proxy // 已归一化 { uri, web, model } | undefined
      const entries = [
        { type: "header", text: `Proxy: ${pc?.uri || "(not set)"}` },
        { type: "item", text: "Set proxy URI…", action: "seturi" },
        { type: "item", text: `Web tools (fetch/websearch): ${!pc || pc.web ? "ON" : "OFF"}`, action: "toggleweb" },
        { type: "item", text: `Model requests (providers with proxy:true): ${pc?.model ? "ON" : "OFF"}`, action: "togglemodel" },
        { type: "item", text: "Test connection", action: "test" },
        { type: "item", text: "Clear proxy", action: "clear" },
      ]
      const c = await showPicker("Proxy", entries, { defaultIndex: proxyIdx })
      if (!c) return // Esc 返回主菜单
      proxyIdx = Math.max(0, entries.filter((e) => e.type === "item").indexOf(c))

      try {
        if (c.action === "seturi") {
          const newUri = await askQuestion("Proxy URI (e.g. http://127.0.0.1:7890):")
          if (!newUri) continue // 空输入不改动
          // web 默认 true、保留原 model 值（对象形态）；旧 string 形态升级为规范对象
          await saveProxy((raw) => {
            raw.proxy = raw.proxy && typeof raw.proxy === "object" && !Array.isArray(raw.proxy)
              ? { ...raw.proxy, uri: newUri }
              : { uri: newUri, web: true, model: false }
          })
          pushLabel("❯ Config", ansi.bold + C.tool)
          pushLine(`proxy.uri = ${newUri}`, C.tool)
        } else if (c.action === "toggleweb" || c.action === "togglemodel") {
          if (!pc) { pushLine("Proxy URI not set — use Set proxy URI… first", C.error); continue }
          const key = c.action === "toggleweb" ? "web" : "model"
          await saveProxy((raw) => { raw.proxy = { ...pc, [key]: !pc[key] } })
          pushLabel("❯ Config", ansi.bold + C.tool)
          pushLine(`proxy.${key} = ${!pc[key] ? "on" : "off"}`, C.tool)
        } else if (c.action === "test") {
          const { proxyFetch, resolveWebProxy } = await import("../proxy.mjs")
          const { UA } = await import("../tools/web.mjs")
          const uri = resolveWebProxy({ agent })
          pushLabel("❯ Config", ansi.bold + C.tool)
          pushLine(`Testing ${uri ? `via proxy ${uri}` : "direct (no proxy)"}...`, C.dim)
          try {
            const res = await Promise.race([
              proxyFetch("https://www.gstatic.com/generate_204", { headers: { "User-Agent": UA } }, uri),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 5s")), 5000)),
            ])
            if (res.ok) pushLine(`✓ OK (HTTP ${res.status})`, C.tool)
            else pushLine(`✗ HTTP ${res.status}`, C.error)
          } catch (error) {
            pushLine(`✗ ${error.message}`, C.error)
          }
        } else if (c.action === "clear") {
          await saveProxy((raw) => { delete raw.proxy })
          pushLabel("❯ Config", ansi.bold + C.tool)
          pushLine("Proxy cleared", C.tool)
        }
      } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
    }
  }

  // Direct args: /config embedkey
  const sub = args[0]?.toLowerCase()
  if (sub === "embedkey") {
    await setEmbedKey()
    return
  }
  if (sub) { pushLine("Usage: /config [embedkey]", C.error); return }

  // ── Main config loop ──
  let running = true
  let mainIdx = 0 // 记住上次选中位置，改完一项回主菜单时恢复
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

    const choice = await showPicker("Config", mainEntries, { defaultIndex: mainIdx })
    if (!choice) { running = false; continue } // Esc
    mainIdx = Math.max(0, mainEntries.filter((e) => e.type === "item").indexOf(choice))

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
      await proxyMenu()
      continue
    }

    if (choice.action === "embedkey") {
      if (await setEmbedKey()) running = false
      continue
    }

    if (choice.action === "agent.verifyGuard") {
      const newVal = ac.verifyGuard !== true
      try {
        await saveProxy((raw) => {
          raw.agent ??= {}
          raw.agent.verifyGuard = newVal
        })
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
        await saveProxy((raw) => {
          raw.embedding ??= {}
          raw.embedding.model = modelChoice.action
        })
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
      const num = Number(val)
      if (isNaN(num)) { pushLine("Value must be a number", C.error); continue }
      await saveProxy((raw) => {
        const keys = label.split(".")
        let obj = raw
        for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] ??= {}; obj = obj[keys[i]] }
        obj[keys[keys.length - 1]] = num
      })
      pushLabel("❯ Config", ansi.bold + C.tool)
      pushLine(`${label} = ${val}`, C.tool)
      pushLine("(restart to apply)", C.dim)
      running = false
    } catch (error) { pushLine(`Save failed: ${error.message}`, C.error) }
  }
}
