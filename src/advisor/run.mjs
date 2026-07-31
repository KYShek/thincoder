/**
 * advisor/run.mjs — advisor execution: tool loop, provider resolution, and the review entry point.
 * Message building lives in advisor.mjs; git collection in advisor/repos.mjs.
 */
import { chat } from "../provider/core.mjs"
import { findProvider } from "../config.mjs"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { toOpenAISchema } from "../tools/index.mjs"
import { prepareAdvisorMessages, ADVISOR_MD_PATH } from "../advisor.mjs"
import { findReviewRepos, isDocOnlyChange } from "./repos.mjs"

export const MAX_ADVISOR_TURNS = 30

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
      signal: (signal && !signal.aborted) ? signal : new AbortController().signal,
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
 * @param {string|null} designToken — injected into the design-review prompt; the advisor echoes it only on approval.
 */
export async function runAdvisorReview(agent, reviewType, callbacks, designToken) {
  const onOutput = callbacks?.onOutput
  const signal = callbacks?.signal
  const cfg = agent.config?.advisor
  // Engineering mode overrides advisor toggle — reviews are mandatory regardless
  if (!cfg?.enabled && !agent.config?.agent?.engineering) return null

  // Design reviews rely on git discovery (design docs may pre-exist, untracked, or
  // written by the parent) — never block on _touchedFiles. For code reviews:
  // engineering mode allows empty _touchedFiles (eng-coder did the mutations).
  if (reviewType !== "design" && !agent.config?.agent?.engineering && (agent._touchedFiles ?? []).length === 0) return null

  const repos = findReviewRepos(agent)

  // Fast path: documentation-only changes skip code review ONLY — design review runs on docs
  if (reviewType !== "design" && !existsSync(join(agent.cwd, ADVISOR_MD_PATH)) && isDocOnlyChange(repos, agent.cwd)) {
    return "No issues found — documentation-only changes, code review skipped."
  }

  const provider = resolveAdvisorProvider(agent)

  // Set the advisor's cwd to the first repo (for tool context)
  const advisorCwd = repos.length > 0 ? repos[0] : agent.cwd

  const messages = prepareAdvisorMessages(agent, reviewType, designToken)

  try {
    const result = await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)
    // Persist the conversation: the next advisor call in this run continues here
    // (reset by runAgent when the run ends — each task gets a fresh advisor session).
    // Design reviews never persist — they always start fresh (no convergence), so a
    // design session must not leak into a later code review.
    agent._advisorSession = reviewType === "design" ? null : messages
    return result
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e
    agent._advisorSession = null // failed review: don't keep a half-built conversation
    return `Advisor: review failed — ${e.message || "unknown error"}. You may retry or proceed to verify.`
  }
}
