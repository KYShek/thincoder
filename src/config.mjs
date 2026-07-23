/**
 * config.mjs — 配置加载与保存
 * 配置文件：~/.thincoder/config.json；API key 可用环境变量兜底。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const configDir = join(homedir(), ".thincoder")
export const configPath = join(configDir, "config.json")

const DEFAULTS = {
  provider: {
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  agent: {
    maxTurns: 50,
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
}

/**
 * 已知模型的上下文窗口（前缀匹配，长的在前）。
 * compactThreshold 未显式配置时，按窗口 * COMPACT_RATIO 自动推导。
 */
const MODEL_CONTEXT_WINDOWS = [
  ["deepseek-v4-pro", 1_000_000],
  ["deepseek-v4-flash", 256_000],
  ["deepseek-reasoner", 64_000],
  ["deepseek-chat", 64_000],
  ["moonshot", 256_000],
  ["kimi", 256_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["qwen", 128_000],
]
const DEFAULT_CONTEXT_WINDOW = 128_000
const COMPACT_RATIO = 0.6

export function contextWindowForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, window] of MODEL_CONTEXT_WINDOWS) {
    if (m.startsWith(prefix)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** 推导压缩阈值；explicit 为配置文件中显式设置的值（优先），否则按模型自动算 */
export function resolveCompactThreshold(explicit, model) {
  if (explicit != null) return { value: explicit, auto: false }
  return { value: Math.floor(contextWindowForModel(model) * COMPACT_RATIO), auto: true }
}

/**
 * 加载配置：文件 + 环境变量兜底（key 不明文落盘时走 env）。
 * 环境变量优先级：THINCODER_API_KEY > DEEPSEEK_API_KEY > OPENAI_API_KEY
 */
export function loadConfig() {
  let config = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf8"))
  }

  const merged = {
    ...DEFAULTS,
    ...config,
    provider: { ...DEFAULTS.provider, ...config.provider },
    agent: { ...DEFAULTS.agent, ...config.agent },
    memory: { ...DEFAULTS.memory, ...config.memory },
    embedding: { ...DEFAULTS.embedding, ...config.embedding },
  }

  if (!merged.provider.apiKey) {
    merged.provider.apiKey =
      process.env.THINCODER_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  }
  if (process.env.THINCODER_BASE_URL) merged.provider.baseURL = process.env.THINCODER_BASE_URL
  if (process.env.THINCODER_MODEL) merged.provider.model = process.env.THINCODER_MODEL
  if (!merged.embedding.apiKey) {
    merged.embedding.apiKey = process.env.SILICONFLOW_API_KEY || process.env.THINCODER_EMBEDDING_API_KEY
  }

  // 压缩阈值跟模型走：配置文件显式设置的优先，否则按模型上下文窗口自动推导
  const explicitThreshold = config.agent?.compactThreshold
  const { value, auto } = resolveCompactThreshold(explicitThreshold, merged.provider.model)
  merged.agent.compactThreshold = value
  merged.agent.compactThresholdAuto = auto

  return merged
}

export function saveConfig(config) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
}
