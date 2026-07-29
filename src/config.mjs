/**
 * config.mjs — configuration loading and saving
 * Multi-provider structure: providers[] + activeProvider
 * Config file: ~/.thincoder/config.json
 * API key can fall back to environment variables (when not configured in providers).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const configDir = join(homedir(), ".thincoder")
export const configPath = join(configDir, "config.json")

/** Built-in provider presets: shared by /provider add <preset> and first-run wizard */
export const PROVIDER_PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 393216, desc: "DeepSeek" },
  kimi:     { baseURL: "https://api.moonshot.cn/v1", model: "kimi-k3", thinking: null, reasoningEffort: "max", maxTokens: 131072, desc: "Kimi / Moonshot" },
  glm:      { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max", maxTokens: 131072, desc: "Zhipu GLM" },
  qwen:     { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max", maxTokens: 131072, desc: "Qwen / Alibaba" },
  minimax:  { baseURL: "https://api.minimaxi.com/v1", model: "MiniMax-M3", thinking: { type: "adaptive" }, maxTokens: 131072, desc: "MiniMax" },
}

// Default provider matches deepseek preset (strip the desc display field)
const { desc: _, ...deepseekPreset } = PROVIDER_PRESETS.deepseek

const DEFAULTS = {
  providers: [{ name: "deepseek", ...deepseekPreset }],
  activeProvider: "deepseek",
  agent: {
    maxTurns: 100,
    subagentTurns: 100,
    goalTurns: 200,
    compactThreshold: 100000,
    verifyGuard: false,  // push model back to verify when files were mutated but verify not run (opt-in)
    streamRules: [],      // time-traveling stream rules: [{ pattern: "regex", message: "reminder", action: "abort"|"warn", repeat: "always"|"once" }]
    advisor: { enabled: false },  // automated code review after each tool-execution turn; optionally: { enabled: true, provider: "deepseek", model: "deepseek-chat" }
    autoThink: false,     // auto-classify task difficulty and set reasoning effort per-turn
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
 * Known model capability spec table (prefix match, longer first).
 * Used for compaction threshold derivation, continuation protocol selection, and capability-aware optimization.
 *
 * context:           context window (tokens)
 * maxOutput:         max output tokens (defaults to context)
 * thinking:          whether thinking/reasoning mode is supported
 * partialMode:       Kimi/Qwen Partial Mode truncation continuation (assistant message with partial:true)
 * prefixMode:        DeepSeek Prefix Completion truncation continuation (uses /beta endpoint, with prefix:true)
 * multimodal:        whether multimodal (image/vision input supported)
 * cacheMode:         context caching mode: "auto"=automatic / "prompt"=needs explicit / "none"=unsupported
 * thinkApi:          thinking API type: "type"=thinking.type field / "effort"=reasoning_effort field
 * thinkOnValue:      when thinkApi is "type", the value used to enable thinking (default "enabled"; MiniMax uses "adaptive")
 * reasoningEcho:     reasoning_content cross-turn echo strategy: "required"=must echo (error if missing) / "optional"=echo optional (default: don't echo)
 * reasoningEffortEnum: valid reasoning_effort enum values (if undeclared, no validation — passed through as-is)
 * tempRange:         valid temperature range [min, max] (if undeclared, no clamping)
 */
const MODEL_SPECS = [
  // DeepSeek V4 series
  ["deepseek-v4-pro",   { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-v4-flash", { context: 1_000_000, maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-reasoner", { context: 256_000,   maxOutput: 384_000, thinking: true,  prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  ["deepseek-chat",     { context: 256_000,   maxOutput: 384_000, thinking: false, prefixMode: true,  cacheMode: "prompt", thinkApi: "type", reasoningEcho: "required", reasoningEffortEnum: ["high", "max"], tempRange: [0, 2] }],
  // Kimi series
  ["kimi-k3",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  partialMode: true, multimodal: true, cacheMode: "auto",  thinkApi: "effort", reasoningEcho: "required", reasoningEffortEnum: ["low", "high", "max"] }],
  ["kimi-k2",           { context: 256_000,   maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none" }],
  ["moonshot",          { context: 128_000,   maxOutput: 32_000,  thinking: false, cacheMode: "none" }],
  // GLM series
  ["glm-5.2",           { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1] }],
  ["glm-5",             { context: 1_000_000, maxOutput: 128_000, thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", reasoningEffortEnum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"], tempRange: [0, 1] }],
  ["glm-4",             { context: 128_000,   maxOutput: 32_000,  thinking: true,  cacheMode: "auto", thinkApi: "type", reasoningEcho: "optional", tempRange: [0, 1] }],
  // GPT series
  ["gpt-4.1",           { context: 1_000_000, maxOutput: 128_000, thinking: false, cacheMode: "prompt" }],
  ["gpt-4o",            { context: 128_000,   maxOutput: 16_000,  thinking: false, multimodal: true, cacheMode: "prompt" }],
  // Qwen series
  ["qwen3.8-max-preview", { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", reasoningEffortEnum: ["xhigh", "medium", "low"], tempRange: [0, 2] }],
  ["qwen3.7-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen3.8-max",       { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-max",          { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen-plus",         { context: 1_000_000, maxOutput: 32_000,  thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  ["qwen",              { context: 1_000_000, maxOutput: 128_000, thinking: false, partialMode: true, multimodal: true, cacheMode: "none", thinkApi: "effort", tempRange: [0, 2] }],
  // MiniMax series
  ["MiniMax-M3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkOnValue: "adaptive", tempRange: [0, 2] }],
  ["minimax-m3",        { context: 1_000_000, maxOutput: 128_000, thinking: true,  multimodal: true, cacheMode: "auto", thinkApi: "type", thinkOnValue: "adaptive", tempRange: [0, 2] }],
  ["minimax-m1",        { context: 256_000,   maxOutput: 128_000, thinking: false, cacheMode: "auto" }],
]
const DEFAULT_SPEC = { context: 128_000, maxOutput: 32_000, cacheMode: "none" }
// Window utilization cap: 0.6 — triggers earlier (reserving 40% headroom) because
// injected context (directory tree, git context, outline, project instructions, memory/doc
// search results) can consume 30-50K tokens each turn; waiting until 80% leaves no room.
// For 1M-window models: 600K is still too high → cap at 300K.
const COMPACT_RATIO = 0.6
const COMPACT_CAP_TOKENS = 300_000
const COMPACT_FLOOR = 40_000

/** Look up spec by model name prefix (case-insensitive), conservative default for unknown models */
export function specForModel(model) {
  const m = (model ?? "").toLowerCase()
  for (const [prefix, spec] of [...MODEL_SPECS].sort((a,b) => b[0].length - a[0].length)) {
    if (m.startsWith(prefix.toLowerCase())) return spec
  }
  return DEFAULT_SPEC
}

/** Derive compaction threshold; explicit is the value explicitly set in config file (takes priority), otherwise auto-computed from model */
export function resolveCompactThreshold(explicit, model) {
  if (explicit != null) return { value: explicit, auto: false }
  const spec = specForModel(model)
  const ratioBased = Math.floor(spec.context * COMPACT_RATIO)
  // Cap for large-window models (1M) and floor for small-window models (<64K, should not compact too aggressively)
  const value = Math.max(Math.min(ratioBased, COMPACT_CAP_TOKENS), COMPACT_FLOOR)
  return { value, auto: true }
}

/**
 * Find provider by name in providers[].
 * Throws if name is non-empty but not found — a typo in activeProvider silently falling to the first provider would use the wrong key on the wrong endpoint.
 * Returns the first provider when name is empty.
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
 * Load configuration.
 * Env var priority: THINCODER_ACTIVE_PROVIDER > config file activeProvider
 * THINCODER_API_KEY / THINCODER_BASE_URL / THINCODER_MODEL override the current active provider's corresponding fields
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

  // Normalize baseURL trailing slash (prevents //chat/completions)
  for (const p of merged.providers) {
    if (p.baseURL) p.baseURL = p.baseURL.replace(/\/+$/, "")
  }

  // Env var overrides activeProvider
  if (process.env.THINCODER_ACTIVE_PROVIDER) {
    merged.activeProvider = process.env.THINCODER_ACTIVE_PROVIDER
  }

  // Get the currently active provider
  const active = findProvider(merged.providers, merged.activeProvider)

  // Build runtime provider object (for agent.provider usage)
  const runtimeProvider = { ...active }

  // Env vars override current active provider's fields
  if (process.env.THINCODER_API_KEY) runtimeProvider.apiKey = process.env.THINCODER_API_KEY
  if (process.env.THINCODER_BASE_URL) runtimeProvider.baseURL = process.env.THINCODER_BASE_URL
  if (process.env.THINCODER_MODEL) runtimeProvider.model = process.env.THINCODER_MODEL

  // apiKey also falls back to env vars (when providers doesn't include a key)
  // Provider-specific env vars only apply to the matching provider name, preventing keys from leaking to wrong endpoints
  if (!runtimeProvider.apiKey?.trim()) {
    const envMap = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }
    const keyVar = envMap[merged.activeProvider]
    if (keyVar && process.env[keyVar]) runtimeProvider.apiKey = process.env[keyVar]
  }

  // embedding apiKey
  if (!merged.embedding.apiKey) {
    merged.embedding.apiKey = process.env.SILICONFLOW_API_KEY || process.env.THINCODER_EMBEDDING_API_KEY
  }

  // Compaction threshold follows the model
  const explicitThreshold = config.agent?.compactThreshold
  const { value, auto } = resolveCompactThreshold(explicitThreshold, runtimeProvider.model)
  merged.agent.compactThreshold = value
  merged.agent.compactThresholdAuto = auto

  // Write back to merged for convenient access by upper layers
  merged.provider = runtimeProvider
  merged.providersList = merged.providers

  return merged
}

/**
 * Save configuration. Preserves providers list structure and activeProvider pointer.
 * providers[i].apiKey is only written when explicitly passed in (does not overwrite env-var-fallback keys).
 */
export function saveConfig(config) {
  mkdirSync(configDir, { recursive: true })
  // 0600: config.json contains API keys, must not be world-readable (POSIX; chmod is best-effort on Windows)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  try { chmodSync(configPath, 0o600) } catch { /* may fail on Windows, ignore */ }
}
