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
  },
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
  }

  if (!merged.provider.apiKey) {
    merged.provider.apiKey =
      process.env.THINCODER_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  }
  if (process.env.THINCODER_BASE_URL) merged.provider.baseURL = process.env.THINCODER_BASE_URL
  if (process.env.THINCODER_MODEL) merged.provider.model = process.env.THINCODER_MODEL

  return merged
}

export function saveConfig(config) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
}
