/**
 * config.mjs — 配置加载与保存
 * 多 provider 结构：providers[] + activeProvider
 * 配置文件：~/.thincoder/config.json
 * API key 可用环境变量兜底（未在 providers 中配置时）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const configDir = join(homedir(), ".thincoder")
export const configPath = join(configDir, "config.json")

/** 内置提供商预设：/provider add <预设名>、首次启动向导共用 */
export const PROVIDER_PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoningEffort: "max", desc: "DeepSeek" },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", thinking: null, reasoningEffort: "high", desc: "Kimi / Moonshot" },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max", desc: "智谱 GLM" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", desc: "通义千问" },
}

// 默认 provider 跟 deepseek 预设保持一致（去掉 desc 展示字段）
const { desc: _presetDesc, ...deepseekPreset } = PROVIDER_PRESETS.deepseek

const DEFAULTS = {
  providers: [{ name: "deepseek", ...deepseekPreset }],
  activeProvider: "deepseek",
  agent: {
    maxTurns: 100,
    compactThreshold: 100000,
  },
  memory: {
    dbPath: join(configDir, "memory.db"),
    projectDir: ".thincoder/memory",
    team: null,
  },
  embedding: {
    baseURL: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-m3",
  },
  mcp: {
    servers: [],
  },
}

/**
 * 已知模型的规格表（前缀匹配，长的在前）。
 * context: 上下文窗口
 * partialMode: Kimi Partial Mode 截断续写协议（assistant 消息带 partial:true；Kimi 与 Qwen 同协议，仅非思考模式）
 * prefixMode: DeepSeek Chat Prefix Completion 截断续写协议（assistant 消息带 prefix:true，走 /beta 端点）
 * compactThreshold 未显式配置时，按窗口 * COMPACT_RATIO 自动推导。
 * 注：deepseek-chat / deepseek-reasoner 已于 2026-07-24 弃用，官方映射到 v4-flash 非思考/思考模式。
 */
const MODEL_SPECS = [
  ["deepseek-v4-pro", { context: 1_000_000, prefixMode: true }],
  ["deepseek-v4-flash", { context: 256_000, prefixMode: true }],
  ["deepseek-reasoner", { context: 256_000, prefixMode: true }],
  ["deepseek-chat", { context: 256_000, prefixMode: true }],
  ["kimi-k3", { context: 1_000_000, partialMode: true }],
  ["kimi-k2", { context: 256_000 }],
  ["moonshot", { context: 128_000 }],
  ["glm-5", { context: 1_000_000 }],
  ["glm-4", { context: 128_000 }],
  ["gpt-4.1", { context: 1_000_000 }],
  ["gpt-4o", { context: 128_000 }],
  ["qwen", { context: 1_000_000, partialMode: true }],
]
const DEFAULT_SPEC = { context: 128_000 }
// 窗口利用率上限：0.8（DeepSeek 内部即全窗口；压缩本身要花一次 LLM 调用，过早压缩是纯浪费。
// 留 20% 余量给压缩后的尾部增长与输出 token）
const COMPACT_RATIO = 0.8

/** 按模型名前缀查规格（大小写不敏感），未知模型给保守默认 */
export function specForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, spec] of [...MODEL_SPECS].sort((a,b) => b[0].length - a[0].length)) {
    if (m.startsWith(prefix)) return spec
  }
  return DEFAULT_SPEC
}

export function contextWindowForModel(model) {
  return specForModel(model).context
}

/** 推导压缩阈值；explicit 为配置文件中显式设置的值（优先），否则按模型自动算 */
export function resolveCompactThreshold(explicit, model) {
  if (explicit != null) return { value: explicit, auto: false }
  return { value: Math.floor(contextWindowForModel(model) * COMPACT_RATIO), auto: true }
}

/**
 * 从 providers[] 中按 name 查找，找不到返回第一个
 */
export function findProvider(providers, name) {
  if (name) {
    const found = providers.find((p) => p.name === name)
    if (found) return found
  }
  return providers[0] ?? { name: "default", baseURL: "", model: "" }
}

/**
 * 加载配置。
 * 环境变量优先级：THINCODER_ACTIVE_PROVIDER > 配置文件 activeProvider
 * THINCODER_API_KEY / THINCODER_BASE_URL / THINCODER_MODEL 覆盖当前激活 provider 的对应字段
 */
export function loadConfig() {
  let config = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"))
    } catch (error) {
      throw new Error(`配置文件不是合法 JSON，请检查或删除: ${configPath}\n  ${error.message}`)
    }
  }

  const merged = {
    ...DEFAULTS,
    ...config,
    providers: config.providers?.length ? config.providers : DEFAULTS.providers,
    activeProvider: config.activeProvider ?? DEFAULTS.activeProvider,
    agent: { ...DEFAULTS.agent, ...config.agent },
    memory: { ...DEFAULTS.memory, ...config.memory },
    embedding: { ...DEFAULTS.embedding, ...config.embedding },
  }

  // baseURL 尾斜杠归一化（防拼出 //chat/completions）
  for (const p of merged.providers) {
    if (p.baseURL) p.baseURL = p.baseURL.replace(/\/+$/, "")
  }

  // 环境变量覆盖 activeProvider
  if (process.env.THINCODER_ACTIVE_PROVIDER) {
    merged.activeProvider = process.env.THINCODER_ACTIVE_PROVIDER
  }

  // 获取当前激活的 provider
  const active = findProvider(merged.providers, merged.activeProvider)

  // 构建运行时 provider 对象（供 agent.provider 使用）
  const runtimeProvider = { ...active }

  // 环境变量覆盖当前激活 provider 的字段
  if (process.env.THINCODER_API_KEY) runtimeProvider.apiKey = process.env.THINCODER_API_KEY
  if (process.env.THINCODER_BASE_URL) runtimeProvider.baseURL = process.env.THINCODER_BASE_URL
  if (process.env.THINCODER_MODEL) runtimeProvider.model = process.env.THINCODER_MODEL

  // apiKey 还可用环境变量兜底（当 providers 里没配 key 时）
  // 提供商专用的环境变量只对同名 provider 生效，避免 key 串到错误的端点
  if (!runtimeProvider.apiKey?.trim()) {
    const envMap = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }
    const keyVar = envMap[merged.activeProvider]
    if (keyVar && process.env[keyVar]) runtimeProvider.apiKey = process.env[keyVar]
  }
  if (!runtimeProvider.apiKey) {
    runtimeProvider.apiKey = process.env.THINCODER_API_KEY
  }

  // embedding apiKey
  if (!merged.embedding.apiKey) {
    merged.embedding.apiKey = process.env.SILICONFLOW_API_KEY || process.env.THINCODER_EMBEDDING_API_KEY
  }

  // 压缩阈值跟模型走
  const explicitThreshold = config.agent?.compactThreshold
  const { value, auto } = resolveCompactThreshold(explicitThreshold, runtimeProvider.model)
  merged.agent.compactThreshold = value
  merged.agent.compactThresholdAuto = auto

  // 回写到 merged 方便上层使用
  merged.provider = runtimeProvider
  merged.providersList = merged.providers

  return merged
}

/**
 * 保存配置。保留 providers 列表结构和 activeProvider 指针。
 * providers[i].apiKey 仅在显式传入时才写入（不覆盖环境变量兜底的 key）
 */
export function saveConfig(config) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
}
