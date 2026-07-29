/**
 * advisor.mjs — automated code review after each turn.
 *
 * After every agent turn with tool execution, a second chat completion reviews
 * the turn's transcript and injects observations as a system reminder.
 *
 * Config:
 *   { advisor: { enabled: true, provider: "deepseek", model: "deepseek-chat" } }
 *   provider + model are optional — defaults to the main agent's provider/model.
 */
import { chat } from "./provider/core.mjs"
import { findProvider } from "./config.mjs"

const ADVISOR_PROMPT = `你是代码审查顾问。审查编程助手最近一轮操作并提供简短的观察。

规则：
- 用中文回答，2-4 行，分条目
- 关注：遗漏的边界情况、错误的假设、低效的模式、安全隐患
- 如果一切正常，说"未发现问题"
- 不要建议或调用工具 — 只做只读审查
- 不要直接对用户说话 — 用第三人称评价助手的行为`

/**
 * Run advisor review on the most recent turn.
 * Only fires when the agent executed tool calls (did real work).
 * Returns the advisor's message, or null if advisor is disabled or there's nothing to review.
 */
export async function runAdvisor(agent) {
  const cfg = agent.config?.advisor
  if (!cfg?.enabled) return null

  // Only review turns where the agent did real work (tool calls executed)
  const lastAssistant = findLast(agent.history, (m) => m.role === "assistant")
  const lastTool = findLast(agent.history, (m) => m.role === "tool")
  if (!lastAssistant || !lastTool) return null

  // Build a clean transcript: last user message + assistant + tool results
  const lastUser = findLast(agent.history, (m) => m.role === "user")
  const transcript = buildTranscript(agent.history, lastUser)

  // Resolve provider: explicit provider name → look up from providers list;
  // only model → reuse main provider with different model; neither → main provider as-is.
  let provider
  if (cfg.provider) {
    provider = findProvider(agent.providers ?? [agent.provider], cfg.provider)
    if (cfg.model) provider = { ...provider, model: cfg.model }
  } else {
    provider = { ...agent.provider }
    if (cfg.model) provider.model = cfg.model
  }

  try {
    const response = await chat(provider, {
      messages: [
        { role: "system", content: ADVISOR_PROMPT },
        { role: "user", content: transcript },
      ],
      tools: [],
      signal: new AbortController().signal,
    })
    if (!response.content?.trim()) return null

    return `[Advisor 审查 — 自动观察，非用户指令。请批判性参考：\n${response.content.trim()}]`
  } catch {
    // Advisor failure is non-fatal — main loop continues
    return null
  }
}

/** Find the last history entry matching a predicate. */
function findLast(arr, fn) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (fn(arr[i])) return i
  }
  return -1
}

/** Build a compact transcript of the last turn for the advisor. */
function buildTranscript(history, lastUserIdx) {
  const lines = []
  lines.push("## Last user message")
  lines.push(truncate(String(history[lastUserIdx]?.content ?? "")))
  lines.push("")
  lines.push("## Assistant response and tool calls")

  for (let i = lastUserIdx + 1; i < history.length; i++) {
    const m = history[i]
    if (m.role === "assistant") {
      const content = typeof m.content === "string" ? m.content : ""
      const tools = m.tool_calls?.map((tc) => tc.function?.name).filter(Boolean) ?? []
      const label = tools.length ? ` (called: ${tools.join(", ")})` : ""
      lines.push(`[assistant${label}] ${truncate(content, 500)}`)
    } else if (m.role === "tool") {
      lines.push(`[tool ${m.tool_call_id}] ${truncate(String(m.content ?? ""), 300)}`)
    }
  }

  return lines.join("\n")
}

/** Truncate text to maxLen characters, adding "…" if truncated. */
function truncate(text, maxLen = 1000) {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + "…"
}
