/**
 * advisor/run.mjs — advisor execution: tool loop, provider resolution, and the review entry point.
 * Message building lives in advisor.mjs; git collection in advisor/repos.mjs.
 */
import { chat } from "../provider/core.mjs"
import { findProvider } from "../config.mjs"
import { toOpenAISchema } from "../tools/index.mjs"
import { prepareAdvisorMessages } from "../advisor.mjs"

export const MAX_ADVISOR_TURNS = 30
// Mechanical convergence cap: the protocol assumes up to 5 rounds suffice
// (full review, verify+fix cycles, strict verification). A 6th call means the
// model is looping — refuse it instead of burning tokens on a review that cannot
// converge. Design reviews are exempt (each call resets the round).
export const MAX_ADVISOR_ROUNDS = 5

const { gitTool, readTool, globTool, grepTool, lsTool } = await import("../tools/index.mjs")
const { lspTool } = await import("../tools/lsp.mjs")
const { codeModeTool: codeSearchTool } = await import("../tools/codemode.mjs")

/** Restricted git tool: diff / status / log only.
 *  Checkpoint create/rewind are blocked — the advisor must not mutate state. */
const advisorGitTool = {
  ...gitTool,
  readonly: true,
  async execute(args, ctx) {
    if (args.action === "checkpoint") {
      if (args.checkpointAction === "create" || args.checkpointAction === "rewind") {
        return "Error: checkpoint create/rewind is disabled in advisor mode. Use diff/status/log only."
      }
    }
    return gitTool.execute(args, ctx)
  },
}

const ADVISOR_TOOLS = [readTool, globTool, grepTool, lsTool, advisorGitTool, lspTool, codeSearchTool]
const ADVISOR_TOOL_SCHEMAS = ADVISOR_TOOLS.map(toOpenAISchema)
const ADVISOR_TOOL_BY_NAME = new Map(ADVISOR_TOOLS.map((t) => [t.name, t]))

/** Compact one-line summary of tool args for panel progress lines.
 *  Picks the most identifying field; falls back to truncated JSON. */
function summarizeToolArgs(args) {
  // e.g. "git diff HEAD", "read src/x.mjs" — action first when present
  const parts = [args.action, args.path ?? args.pattern ?? args.command].filter((v) => v != null)
  let s = parts.length > 0 ? parts.map(String).join(" ") : JSON.stringify(args)
  s = s.replace(/\s+/g, " ").trim()
  return s.length > 80 ? s.slice(0, 79) + "…" : s
}

/**
 * Run the advisor's tool loop: chat → execute tools → repeat.
 * Stops when the model produces text without tool calls.
 *
 * Progress lines (→ tool args) are emitted via onOutput between model bursts so
 * the panel keeps moving while the advisor explores — otherwise the panel sits
 * frozen through every tool-call phase and the review appears to have stalled.
 */
async function runAdvisorToolLoop(provider, messages, onOutput, signal, agent, cwd) {
  // Kind-tagged wrappers: the TUI panel colors reasoning / answer / tool progress differently.
  const emit = (kind) => (onOutput ? (text) => onOutput({ kind, text }) : undefined)
  const onThink = emit("think")
  const onText = emit("text")
  let turns = 0
  while (true) {
    // Interrupted (Ctrl+I) — stop immediately instead of spinning a fresh uncancellable signal
    if (signal?.aborted) return "Advisor: interrupted."
    if (++turns > MAX_ADVISOR_TURNS) {
      return "Advisor: stopped after " + MAX_ADVISOR_TURNS + " tool rounds — the review appears to be looping. You may retry with a narrower scope."
    }
    const response = await chat(provider, {
      messages,
      tools: ADVISOR_TOOL_SCHEMAS,
      signal: (signal && !signal.aborted) ? signal : null,
      onToken: onText,
      onReasoning: onThink,
    })

    // No tool calls — this is the final review text
    if (!response.toolCalls?.length) {
      if (!response.content?.trim()) return "Advisor: (empty response — review was inconclusive)"
      return response.content.trim()
    }

    // Push assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute each tool call
    for (const tc of response.toolCalls) {
      const tool = ADVISOR_TOOL_BY_NAME.get(tc.name)
      let args = {}
      try { args = JSON.parse(tc.arguments || "{}") } catch { /* summarized as raw JSON below */ }
      onOutput?.({ kind: "tool", text: `\n→ ${tc.name} ${summarizeToolArgs(args)}\n` })
      let result
      if (!tool) {
        result = `Error: unknown tool "${tc.name}". Available: ${[...ADVISOR_TOOL_BY_NAME.keys()].join(", ")}`
      } else {
        try {
          result = await tool.execute(args, {
            cwd,
            agent,
            onOutput,
            signal,
          })
        } catch (e) {
          result = `Error: ${e.message}`
        }
      }
      if (typeof result !== "string") result = JSON.stringify(result)
      const limited = result.length > 12_000 ? result.slice(0, 12_000) + "\n… (truncated)" : result
      messages.push({ role: "tool", tool_call_id: tc.id, content: limited })
    }
  }
}

/** Resolve the advisor's provider: cfg.provider/model when set, otherwise the main agent's provider */
export function resolveAdvisorProvider(agent) {
  const cfg = agent.config?.advisor
  if (cfg?.provider) {
    try {
      const provider = findProvider(agent.providers ?? [agent.provider], cfg.provider)
      const result = cfg.model ? { ...provider, model: cfg.model } : { ...provider }
      if (cfg.thinking === null) result.thinking = undefined  // explicitly off
      else if (cfg.thinking !== undefined) result.thinking = cfg.thinking
      if (cfg.reasoningEffort !== undefined) result.reasoningEffort = cfg.reasoningEffort
      return result
    } catch (e) {
      // Provider not found or lookup failed — fall back to main provider, but surface the reason
      console.warn(`[advisor] resolveAdvisorProvider: ${e.message}`)
    }
  }
  const provider = { ...agent.provider }
  if (cfg?.model) provider.model = cfg.model
  if (cfg?.thinking === null) provider.thinking = undefined  // explicitly off
  else if (cfg?.thinking !== undefined) provider.thinking = cfg.thinking
  if (cfg?.reasoningEffort !== undefined) provider.reasoningEffort = cfg.reasoningEffort
  return provider
}

/**
 * Run an advisor review. reviewType: "code" (default) or "design". Returns review text or null when skipped.
 * @param {string|null} [designToken] — injected into the design-review prompt; the advisor echoes it only on approval.
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review; passed through to the message builder.
 */
export async function runAdvisorReview(agent, reviewType, callbacks, designToken = null, documents = null, paths = null) {
  const onOutput = callbacks?.onOutput
  const signal = callbacks?.signal
  const cfg = agent.config?.advisor
  // Engineering mode overrides advisor toggle — reviews are mandatory regardless
  if (!cfg?.enabled && !agent.config?.agent?.engineering) return "Advisor: not enabled (set advisor.enabled in config.json)."

  // Mechanical convergence cap — refuse further reviews once the protocol has run
  // its rounds. _advisorRound counts completed advisor calls (incremented by the
  // agent after each one), so >= MAX_ADVISOR_ROUNDS blocks the next call.
  if (reviewType !== "design" && (agent._advisorRound || 0) >= MAX_ADVISOR_ROUNDS) {
    return `Advisor: convergence cap reached after ${MAX_ADVISOR_ROUNDS} rounds — the protocol assumes convergence by round ${MAX_ADVISOR_ROUNDS}. Accept the current state or manually re-review; do not call advisor again.`
  }

  const provider = resolveAdvisorProvider(agent)
  // Advisor always works in the agent's cwd — scope is defined by paths/documents.
  const advisorCwd = agent.cwd

  const messages = prepareAdvisorMessages(agent, reviewType, designToken, documents, paths)

  try {
    const result = await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)
    // Only persist the session on success — timeout/interrupt/empty results
    // would poison the next review call (the conversation is truncated mid-review,
    // and the model picks up from a broken state, burning more rounds).
    if (!result.trimStart().startsWith("Advisor:")) {
      // Assign only for fresh sessions; re-assignment of the same reference on
      // continued sessions is a no-op but communicating intent matters.
      agent._advisorSession = reviewType === "design" ? null : messages
    } else {
      agent._advisorSession = null
    }
    return result
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e
    agent._advisorSession = null // failed review: don't keep a half-built conversation
    return `Advisor: review failed — ${e.message || "unknown error"}. You may retry or proceed to verify.`
  }
}
