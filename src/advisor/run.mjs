/**
 * advisor/run.mjs — advisor execution: tool loop, provider resolution, and the review entry point.
 * Message building lives in advisor.mjs; git collection in advisor/repos.mjs.
 */
import { chat } from "../provider/core.mjs"
import { findProvider } from "../config.mjs"
import { toOpenAISchema } from "../tools/index.mjs"
import { prepareAdvisorMessages } from "../advisor.mjs"
import { extractPriorIssueTable } from "../advisor/history.mjs"

const MAX_ADVISOR_TURNS = 100
// Mechanical convergence cap: the protocol assumes up to 5 rounds suffice
// (full review, verify+fix cycles, strict verification). A 6th call means the
// model is looping — refuse it instead of burning tokens on a review that cannot
// converge. Code AND design reviews share the 5-round budget (each advances
// _advisorRound in agent.mjs; the cap no longer exempts design).
// NOTE: prompts/advisor-round{1,2,3}.md advertise a 30-round BUDGET — the
// prompt-level efficiency target, distinct from this 100-round mechanical hard
// cap (loop guard). Keep both in sync when either changes.
export const MAX_ADVISOR_ROUNDS = 5

// Context window limits
const MAX_CONTEXT_TOKENS = 120_000 // 预留 headroom，避免 OOM
const TOOL_TIMEOUT_MS = 30_000 // 单个工具 30 秒
const REVIEW_TIMEOUT_MS = 300_000 // 整个审查 5 分钟

/** Estimate token count from messages (rough: 1 token ≈ 4 chars) */
function estimateTokens(messages) {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "")
    const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : ""
    return sum + Math.ceil((content.length + toolCalls.length) / 4)
  }, 0)
}

/** Compact early messages when context grows too large */
async function compactMessages(messages, provider) {
  // Keep: system prompt, last 10 assistant+tool pairs, user message
  if (messages.length <= 20) return messages
  
  const system = messages[0]
  const recent = messages.slice(-20)
  const old = messages.slice(1, -20)
  
  // Summarize old messages
  const summary = `Earlier exploration: ${old.length} tool calls completed. Key files examined: ${
    old
      .filter((m) => m.role === "tool")
      .map((m) => m.content?.split("\n")[0]?.slice(0, 50))
      .filter(Boolean)
      .slice(0, 5)
      .join(", ")
  }`
  
  return [system, { role: "user", content: `[Context compacted] ${summary}` }, ...recent]
}

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

/**
 * Round-aware advisor tool set.
 * - Round 1: full set incl. git (diff/status/log) — the reviewer discovers the
 *   change surface with `git diff` since no diff is injected into the message.
 * - Rounds 2+ (convergence): NO git tool. A stale diff misled re-reviews —
 *   committed fixes never show in `git diff HEAD`, so "no changes" was read as
 *   "not fixed" (decision 7d49a52: verification is `read`-only). Removing the
 *   tool closes the loop the prompt could not.
 * Predicate `_advisorRound === 0` is kept in sync with buildAdvisorSystemPrompt's
 * ROUND1 selection (`!prior || _advisorRound === 0`): prepareAdvisorMessages
 * resets the round to 0 whenever a review starts without a prior table, so the
 * two predicates agree on every path (all-clear, fresh start, failed retry).
 */
function advisorToolsFor(agent) {
  const tools = (agent._advisorRound || 0) > 0
    ? [readTool, globTool, grepTool, lsTool, lspTool, codeSearchTool]
    : ADVISOR_TOOLS
  return { schemas: tools.map(toOpenAISchema), byName: new Map(tools.map((t) => [t.name, t])) }
}
// Test seam: the round-aware tool set is pure (agent._advisorRound → tools).
export { advisorToolsFor as _advisorToolsFor }

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
  const { schemas: toolSchemas, byName: toolByName } = advisorToolsFor(agent)
  let turns = 0
  const startTime = Date.now()
  
  while (true) {
    // Interrupted (Ctrl+I) — stop immediately instead of spinning a fresh uncancellable signal
    if (signal?.aborted) return "Advisor: interrupted."
    
    // Check review timeout (5 minutes)
    if (Date.now() - startTime > REVIEW_TIMEOUT_MS) {
      return `Advisor: review timeout after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s. Partial results may be available. Try again with a narrower scope.`
    }
    
    if (++turns > MAX_ADVISOR_TURNS) {
      return "Advisor: stopped after " + MAX_ADVISOR_TURNS + " tool rounds — the review appears to be looping. You may retry with a narrower scope."
    }
    
    // Check context window and compact if needed
    const currentTokens = estimateTokens(messages)
    if (currentTokens > MAX_CONTEXT_TOKENS * 0.8) {
      onOutput?.({ kind: "text", text: `\n[Context compacted: ${currentTokens} tokens → reducing to fit window]\n` })
      messages = await compactMessages(messages, provider)
      if (estimateTokens(messages) > MAX_CONTEXT_TOKENS) {
        return `Advisor: context window limit reached (${currentTokens} tokens). Review incomplete — too many tool calls. Try a narrower scope.`
      }
    }
    
    const response = await chat(provider, {
      messages,
      tools: toolSchemas,
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
      const tool = toolByName.get(tc.name)
      let args = {}
      let parseError = null
      try {
        args = JSON.parse(tc.arguments || "{}")
      } catch (e) {
        parseError = `Error: invalid JSON in tool arguments: ${e.message}\nRaw arguments: ${(tc.arguments || "").slice(0, 200)}`
      }
      
      // If parse failed, return error to model immediately
      if (parseError) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: parseError })
        continue
      }
      
      onOutput?.({ kind: "tool", text: `\n→ ${tc.name} ${summarizeToolArgs(args)}\n` })
      let result
      if (!tool) {
        result = `Error: unknown tool "${tc.name}". Available: ${[...toolByName.keys()].join(", ")}`
      } else {
        // Execute with timeout (clear the timer when the tool wins the race —
        // otherwise up to MAX_ADVISOR_TURNS dangling timers accumulate)
        try {
          let timeoutId
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`tool timeout after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
          })
          try {
            result = await Promise.race([
              tool.execute(args, { cwd, agent, onOutput, signal }),
              timeoutPromise,
            ])
          } finally {
            clearTimeout(timeoutId)
          }
        } catch (e) {
          const errorType = e.message.includes("timeout") ? "timeout"
            : e.message.includes("ENOENT") ? "file_not_found"
            : e.message.includes("permission") ? "permission_denied"
            : "execution_error"
          result = `Error (${errorType}): ${e.message}`
        }
      }
      if (typeof result !== "string") result = JSON.stringify(result)
      
      // Line-aware truncation: preserve line integrity
      const MAX_RESULT_CHARS = 12_000
      if (result.length > MAX_RESULT_CHARS) {
        const lines = result.split("\n")
        let truncated = ""
        let charCount = 0
        let keptLines = 0
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (charCount + line.length + 1 > MAX_RESULT_CHARS) break
          truncated += line + "\n"
          charCount += line.length + 1
          keptLines++
        }
        
        const remainingLines = lines.length - keptLines
        result = (
          truncated +
          `\n… (truncated: ${remainingLines} more lines, ${result.length} chars total)\n` +
          `To see more content, use: read(path, offset=${keptLines}, limit=200)`
        )
      }
      
      messages.push({ role: "tool", tool_call_id: tc.id, content: result })
    }
  }
}

/** Resolve the advisor's provider: cfg.provider/model when set, otherwise the main agent's provider */
function resolveAdvisorProvider(agent) {
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
 * Extract unfixed issues from prior review text
 */
function extractUnfixedIssues(priorText) {
  if (!priorText) return []
  const lines = priorText.split("\n")
  return lines
    .filter((line) => /\|\s*\d+\s*\|/.test(line)) // 匹配表格行
    .filter((line) => !/fixed|resolved|done|✓|✔/i.test(line))
    .map((line) => line.replace(/\|/g, "").trim())
    .filter(Boolean)
    .slice(0, 10) // 最多显示 10 个
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
  const startTime = Date.now()
  
  // Engineering mode overrides advisor toggle — reviews are mandatory regardless
  if (!cfg?.enabled && !agent.config?.agent?.engineering) {
    return "Advisor: not enabled (set advisor.enabled in config.json)."
  }

  // Mechanical convergence cap — refuse further reviews once the protocol has run
  // its rounds. _advisorRound counts completed advisor calls (incremented by the
  // agent after each one — code AND design reviews alike), so >= MAX_ADVISOR_ROUNDS
  // blocks the next call. 5 rounds max; after that the review is never pushed back
  // (the caller decides: accept, manual re-check, or /new to reset).
  if ((agent._advisorRound || 0) >= MAX_ADVISOR_ROUNDS) {
    // 提取未解决的问题，给出更具体的指导
    const prior = extractPriorIssueTable(agent.history)
    const unfixed = prior ? extractUnfixedIssues(prior.text) : []
    
    let message = `Advisor: convergence cap reached after ${MAX_ADVISOR_ROUNDS} rounds.\n`
    if (unfixed.length > 0) {
      message += `\nUnresolved issues from prior rounds:\n${unfixed.map((i) => `- ${i}`).join("\n")}\n`
    } else {
      message += "\nAll prior issues appear resolved.\n"
    }
    message += "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session (/new) to reset the advisor"
    
    return message
  }

  const provider = resolveAdvisorProvider(agent)
  // Advisor always works in the agent's cwd — scope is defined by paths/documents.
  const advisorCwd = agent.cwd

  const messages = prepareAdvisorMessages(agent, reviewType, designToken, documents, paths)

  try {
    const result = await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)
    
    // Log review statistics for observability
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const toolCallCount = messages.filter((m) => m.role === "tool").length
    const tokensUsed = estimateTokens(messages)
    onOutput?.({
      kind: "text",
      text: `\n[advisor] Review completed: ${elapsed}s, ${toolCallCount} tool calls, ~${Math.round(tokensUsed / 1000)}k tokens\n`,
    })
    
    // Only persist the session on success — timeout/interrupt/empty results
    // would poison the next review call (the conversation is truncated mid-review,
    // and the model picks up from a broken state, burning more rounds).
    // Design reviews persist the session too: their rounds 2+ continue it.
    if (!result.trimStart().startsWith("Advisor:")) {
      // Assign only for fresh sessions; re-assignment of the same reference on
      // continued sessions is a no-op but communicating intent matters.
      agent._advisorSession = messages
    } else {
      agent._advisorSession = null
    }
    return result
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e
    
    // 细化错误类型
    const errorType = e.message.includes("rate limit") || e.message.includes("429") ? "rate limit"
      : e.message.includes("timeout") ? "timeout"
      : e.message.includes("network") || e.message.includes("ECONNREFUSED") ? "network"
      : e.message.includes("context length") ? "context_too_long"
      : "unknown"
    
    const retryAdvice = errorType === "rate limit"
      ? "Wait a moment and retry. Consider using a cheaper model for advisor."
      : errorType === "timeout"
        ? "The model took too long. Try with a narrower scope."
        : errorType === "context_too_long"
          ? "Reduce the scope (fewer files/paths) or use a model with larger context window."
          : "You may retry or proceed to verify manually."
    
    agent._advisorSession = null // failed review: don't keep a half-built conversation
    return `Advisor: review failed (${errorType}) — ${e.message || "unknown error"}. ${retryAdvice}`
  }
}
