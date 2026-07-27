import { existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { configPath, saveConfig, PROVIDER_PRESETS } from "../config.mjs"

/** 首次使用（TTY 下的 chat/distill）：问答式配置一个 provider 并落盘，返回运行时 provider；取消返回 null */
export async function setupWizard() {
  // 自带缓冲的提问器：rl.question 在输入被管道/快速粘贴时会丢行（问题注册前 line 已到达）
  const rl = createInterface({ input: process.stdin, terminal: false })
  const buffered = []
  let waiter = null
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      buffered.push(line)
    }
  })
  const ask = (q) =>
    new Promise((resolve) => {
      process.stderr.write(q)
      if (buffered.length) resolve(buffered.shift())
      else waiter = resolve
    })
  try {
    const presets = Object.entries(PROVIDER_PRESETS)
    console.error("首次使用，先配置一个模型提供商：")
    presets.forEach(([n, p], i) => console.error(`  ${i + 1}. ${n.padEnd(10)} ${p.desc}`))
    console.error(`  ${presets.length + 1}. 自定义端点`)
    const choice = Number((await ask(`选择 [1-${presets.length + 1}]: `)).trim())
    let name, baseURL, model
    if (choice === presets.length + 1) {
      name = (await ask("名称（如 my-openai）: ")).trim()
      baseURL = (await ask("baseURL（如 https://api.openai.com/v1）: ")).trim().replace(/\/+$/, "")
      model = (await ask("模型（如 gpt-4o）: ")).trim()
      if (!name || !/^https?:\/\//.test(baseURL) || !model) {
        console.error("输入不完整或 baseURL 不合法，已取消")
        return null
      }
    } else if (choice >= 1 && choice <= presets.length) {
      name = presets[choice - 1][0]
      baseURL = presets[choice - 1][1].baseURL
      model = presets[choice - 1][1].model
    } else {
      console.error("无效选择，已取消")
      return null
    }
    const apiKey = (await ask(`${name} 的 API key: `)).trim()
    if (!apiKey) {
      console.error("key 不能为空，已取消")
      return null
    }
    const embedKey = (await ask("可选：embedding API key（SiliconFlow，向量检索用；回车跳过）: ")).trim()
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    const providers = raw.providers?.length ? raw.providers : []
    const existing = providers.find((p) => p.name === name)
    if (existing) Object.assign(existing, { baseURL, model, apiKey })
    else providers.push({ name, baseURL, model, apiKey })
    raw.providers = providers
    raw.activeProvider = name
    if (embedKey) raw.embedding = { ...(raw.embedding ?? {}), apiKey: embedKey }
    saveConfig(raw)
    console.error(`配置完成：${name} / ${model}（已写入 ${configPath}）`)
    console.error(embedKey ? "向量检索已启用\n" : "（未配 embedding key：记忆为纯文本检索，之后在 config.json 的 embedding.apiKey 补上即可开启向量检索）\n")
    return { name, baseURL, model, apiKey }
  } finally {
    rl.close()
  }
}
