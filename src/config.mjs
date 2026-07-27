/**
 * config.mjs — 配置加载与保存
 * 多 provider 结构：providers[] + activeProvider
 * 配置文件：~/.thincoder/config.json
 * API key 可用环境变量兜底（未在 providers 中配置时）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const configDir = join(homedir(), ".thincoder")
export const configPath = join(configDir, "config.json")

/** 内置提供商预设：/provider add <预设名>、首次启动向导共用 */
export const PROVIDER_PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 393216, desc: "DeepSeek" },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", thinking: null, reasoningEffort: "max", maxTokens: 131072, desc: "Kimi / Moonshot" },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 131072, desc: "Zhipu GLM" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", maxTokens: 131072, desc: "Qwen / Alibaba" },
  minimax:  { baseURL: "https://api.minimax.chat/v1", chatPath: "/text/chatcompletion_v2", model: "MiniMax-M3", maxTokens: 131072, desc: "MiniMax" },
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
 * 已知模型的能力规格表（前缀匹配，长的在前）。
 * 用于压缩阈值推导、截断续写协议选择、能力感知优化。
 *
 * context:           上下文窗口（tokens）
 * maxOutput:         最大输出 tokens（默认 context）
 * thinking:          是否支持思考/推理模式
 * partialMode:       Kimi/Qwen Partial Mode 截断续写（assistant 消息带 partial:true）
 * prefixMode:        DeepSeek Prefix Completion 截断续写（走 /beta 端点，带 prefix:true）
 * multimodal:        是否多模态（支持图片/视觉输入）
 * cacheMode:         上下文缓存方式："auto"=自动/"prompt"=需显式/"none"=不支持
 * thinkApi:          思考模式 API 类型："type"=thinking.type 字段 / "effort"=reasoning_effort 字段
 * reasoningEcho:     reasoning_content 跨轮回传策略："required"=必须回传(缺失报错)/"optional"=回传可选(默认不回传)
 * reasoningEffortEnum: reasoning_effort 合法枚举值（未声明则不校验，原样透传）
 * tempRange:         temperature 合法范围 [min, max]（未声明则不裁剪）
 */
const MODEL_SPECS = [
  // DeepSeek V4 系列
  ["deepseek-v4-pro",   { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-v4-flash", { context: 256_000,   maxOutput: 384_000, thinking: false, prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-reasoner", { context: 256_000,   maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-chat",     { context: 256_000,   maxOutput: 384_000, thinking: false, prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  // Kimi 系列
  ["kimi-k3",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  partialMode: true, multimodal: true, cacheMode: "prompt", thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"] }],
  ["kimi-k2",           { context: 256_000,   maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none" }],
  ["moonshot",          { context: 128_000,   maxOutput: 32_000,  thinking: false, cacheMode: "none" }],
  // GLM 系列
  ["glm-5.2",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1] }],
  ["glm-5",             { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1] }],
  ["glm-4",             { context: 128_000,   maxOutput: 32_000,  thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", tempRange: [0, 1] }],
  // GPT 系列
  ["gpt-4.1",           { context: 1_000_000, maxOutput: 128_000, thinking: false, cacheMode: "prompt" }],
  ["gpt-4o",            { context: 128_000,   maxOutput: 16_000,  thinking: false, multimodal: true, cacheMode: "prompt" }],
  // Qwen 系列
  ["qwen3.8-max-preview", { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"], tempRange: [0, 2] }],
  ["qwen3.7-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen3.8-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-max",          { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-plus",         { context: 1_000_000, maxOutput: 32_000,  thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen",              { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  // MiniMax 系列
  ["MiniMax-M3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", tempRange: [0, 2] }],
  ["minimax-m3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", tempRange: [0, 2] }],
  ["minimax-m1",        { context: 256_000,   maxOutput: 128_000, thinking: false, cacheMode: "auto" }],
]
const DEFAULT_SPEC = { context: 128_000, maxOutput: 32_000, cacheMode: "none" }
// 窗口利用率上限：0.8（DeepSeek 内部即全窗口；压缩本身要花一次 LLM 调用，过早压缩是纯浪费。
// 留 20% 余量给压缩后的尾部增长与输出 token）
// 但 1M 窗口模型按 0.8 算 = 80 万 token，历史涨到那么大才压缩会打爆 TPM 预算、
// 压缩请求本身也可能 429。加 cap：不超过 maxOutput 的 8 倍（128K×8≈100万→实际仍偏大但合理），
// 不超过 30 万（大窗口模型的合理工作上限，再大缓存命中率下降）
const COMPACT_RATIO = 0.8
const COMPACT_CAP_TOKENS = 300_000

/** 按模型名前缀查规格（大小写不敏感），未知模型给保守默认 */
export function specForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, spec] of [...MODEL_SPECS].sort((a,b) => b[0].length - a[0].length)) {
    if (m.startsWith(prefix.toLowerCase())) return spec
  }
  return DEFAULT_SPEC
}

export function contextWindowForModel(model) {
  return specForModel(model).context
}

/** 推导压缩阈值；explicit 为配置文件中显式设置的值（优先），否则按模型自动算 */
export function resolveCompactThreshold(explicit, model) {
  if (explicit != null) return { value: explicit, auto: false }
  const spec = specForModel(model)
  const ratioBased = Math.floor(spec.context * COMPACT_RATIO)
  // 大窗口模型（1M）按比例算出来太大，用 cap 限制——宁可早压缩也别让历史涨到打爆 TPM
  const value = Math.min(ratioBased, COMPACT_CAP_TOKENS)
  return { value, auto: true }
}

/**
 * 从 providers[] 中按 name 查找。
 * name 非空但找不到时抛错——activeProvider 打错字静默落到第一个 provider，会拿错 key 打错端点。
 * name 为空时返回第一个。
 */
export function findProvider(providers, name) {
  if (name) {
    const found = providers.find((p) => p.name === name)
    if (found) return found
    const available = providers.map((p) => p.name).join(", ") || "(empty)"
    throw new Error(`activeProvider "${name}" not in providers list (available: ${available}); check for a typo in: ${configPath}`)
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
      throw new Error(`Config file is not valid JSON, check or delete it: ${configPath}\n  ${error.message}`)
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
  // 0600：config.json 含 API key，不能世界可读（POSIX；Windows 下 chmod 尽力而为）
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  try { chmodSync(configPath, 0o600) } catch { /* Windows 上可能失败，忽略 */ }
}
