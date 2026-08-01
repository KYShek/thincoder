/**
 * agent.mjs — Agent main loop
 * LLM ↔ tool-call loop, until the task is done.
 */
import { chat } from "./provider/index.mjs"
import { compressIfNeeded, compressFallback, COMPRESS_FAILURE_LIMIT } from "./context.mjs"
import { specForModel } from "./config.mjs"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { executeToolCalls } from "./agent/dispatch.mjs"
import { prepareRun } from "./agent/setup.mjs"
import { injectPostTurn, STALL_WINDOW_SIZE, STALL_THRESHOLD, GOAL_BUDGET_WARN_RATIO } from "./agent/post-turn.mjs"
import { handleCompletion } from "./agent/completion.mjs"
import { isDocFile } from "./advisor/repos.mjs"
import {
  escapeXml, tryCanonicalize, repairHistory, listWorkDir,
  readonlyToolNames, collectGitContext, loadProjectInstructions,
  ContinueError, FILE_MUTATORS,
  DEFAULT_MAX_TURNS, DEFAULT_SUBAGENT_TURNS,
  MIN_REPORT_CHARS, REPORT_CONTINUATION, OUTLINE_INJECT_PREFIX,
} from "./agent/helpers.mjs"

// Prompt files (byte-stable, loaded once)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "system.md"), "utf8")
const DISCIPLINE_RULES = readFileSync(join(__dirname, "prompts", "discipline.md"), "utf8")
const MAIN_OVERLAY = readFileSync(join(__dirname, "prompts", "main.md"), "utf8")
let _EXPLORE, _CODER, _PLAN, _ENG_CODER
try { _EXPLORE = readFileSync(join(__dirname, "prompts", "explore.md"), "utf8") } catch { _EXPLORE = "" }
try { _CODER = readFileSync(join(__dirname, "prompts", "coder.md"), "utf8") } catch { _CODER = "" }
try { _PLAN = readFileSync(join(__dirname, "prompts", "plan.md"), "utf8") } catch { _PLAN = "" }
try { _ENG_CODER = readFileSync(join(__dirname, "prompts", "eng-coder.md"), "utf8") } catch { _ENG_CODER = "" }
export const EXPLORE_OVERLAY = _EXPLORE
export const CODER_OVERLAY = _CODER
export const PLAN_OVERLAY = _PLAN
export const ENG_CODER_OVERLAY = _ENG_CODER

// exported for consumption by agent-tools.mjs
export {
  ContinueError,
  repairHistory, listWorkDir, loadProjectInstructions,
  readonlyToolNames, collectGitContext, escapeXml,
  MIN_REPORT_CHARS, REPORT_CONTINUATION, DEFAULT_SUBAGENT_TURNS,
}

let _reindexFile = null
const AUTO_REMINDER = "[System reminder: AUTO mode is active — all tool calls are automatically approved without asking.]"


const ENG_ON_REMINDER =
  "[System reminder: engineering mode is ON — design-before-code enforced. " +
  "Workflow: Requirements doc → Design doc → advisor(type='design') → " +
  "user approval → eng-coder implementation. Code changes go through eng-coder " +
  "subagents only. Advisor calls are NOT per-turn-mandatory — call only at " +
  "flow nodes or when the user asks.]"

/**
 * True when this run mutated at least one CODE file. Doc-only changes
 * (docs/, *.md, LICENSE…) must NOT trigger the advisor/verify guards — the
 * design phase edits docs/ and must not be pushed to a code review.
 * Mutations without a known path (tools outside FILE_MUTATORS) are treated as
 * code — cannot tell, so guard conservatively.
 * Product-code semantics match isProductCode: anything under src/ (incl.
 * src/prompts/*.md) is code; anything else that isn't a doc file is code.
 * NOTE: _touchedFiles stores ABSOLUTE paths (join(cwd, p)), so the src/ check
 * matches a path component (works for "src/..." and "D:\...\src\..." alike),
 * not a bare ^src prefix — the literal ^src[\\/] form would be dead code here.
 */
export function hasCodeMutations(agent) {
  const files = agent._touchedFiles ?? []
  if (files.length === 0) return agent._mutatedThisRun
  return files.some((p) => /(?:^|[\\/])src[\\/]/.test(p) || !isDocFile(p))
}

/** Engineering-mode status injection — one reminder when engineering mode is ON. */
function injectEngineeringReminder(agent) {
  const eng = agent.config?.agent?.engineering ?? false
  // Only notify on transitions into ON — OFF is silence (the system prompt
  // already carries the standard discipline; no need to remind the model
  // that it's in the default mode).
  if (eng && !agent._lastEngState) {
    agent.history.push({ role: "user", content: ENG_ON_REMINDER, transient: true })
  }
  agent._lastEngState = eng
}

/** Create a new agent state object with all fields initialized to defaults */
export function createAgent({
  provider, tools, config, cwd, memory, overlay, role,
  tasks = [], history = [],
  planMode = false, autoApprove = false,
  goal = null, sessionStart = null,
}) {
  return {
    provider, tools, config, cwd, memory, _role: role,
    overlay, tasks, history,
    planMode, autoApprove, goal,
    _mutatedThisRun: false, _verifiedThisRun: false, _verifyPassed: undefined, _calledAdvisorThisRun: false,
    _engDesignReviewed: false, // eng-coder: design review gate passed (hard gate in dispatch.mjs)
    _engDesignToken: null, // issued by advisor(type="design"); required to spawn eng-coder
    _touchedFiles: [], _verifyRetries: 0, _advisorRound: 0, _advisorSession: null, _advisorLastSnapshot: null,
    _lastEngState: false,
    _pendingReminders: [],
    _pendingTimers: [],
    _sessionStart: sessionStart,
    _lastPromptTokens: null, _usageAtLen: null,
    _compressFailures: 0,
  }
}

/** Run the agent loop: LLM ↔ tool-call cycle until task completion or turn limit. Returns final text content. */
export async function runAgent(agent, input, callbacks = {}, { depth = 0, signal, maxTurns: overrideTurns, resume = false } = {}) {
  const { maxTurns, threshold, tools, toolSchemas, toolByName, systemPrompt } = await prepareRun(
    agent, input, callbacks,
    { depth, signal, overrideTurns, resume, systemPrompt: SYSTEM_PROMPT, disciplineRules: DISCIPLINE_RULES, mainOverlay: MAIN_OVERLAY },
  )

  // Per-run bookkeeping reset. On `resume` (ContinueError continuation) these are
  // PRESERVED: the resumed run must keep mutation tracking so the advisor/verify
  // guards stay active (a guard pushback on the last turn must not silently vanish),
  // and the convergence budget must not be resettable by continuing the session.
  if (!resume) {
    agent._mutatedThisRun = false
    agent._verifiedThisRun = false
    agent._verifyPassed = undefined
    agent._calledAdvisorThisRun = false
    agent._touchedFiles = []
    agent._verifyRetries = 0
    agent._advisorRound = 0
    agent._advisorSession = null // advisor session is per-run: discard when the task ends, next task starts fresh
    agent._advisorLastSnapshot = null // dedup baseline is per-run too — stale snapshot could wrongly suppress a diff refresh
  }
  // eng-coder authorization is set by subagent.mjs AFTER token validation but BEFORE runAgent —
  // only reset for the top-level agent (depth 0); child runs must keep their granted authorization
  if (depth === 0) agent._engDesignReviewed = false
  // _engDesignToken survives across turns within the same agent (design review → user approval → spawn eng-coder).
  // Lifecycle: invalidated on a failed re-review (advisor.mjs), issued on a passing review.
  let guardPushbacks = 0
  let advisorPushbacks = 0
  let honestReminderInjected = false
  const recentCallSigs = []
  // repeat: "once" stream rules fire at most once per runAgent call (user turn):
  // this set survives across chat() calls (rule abort-retry, tool loop) within the turn.
  const streamRuleFired = new Set()

  for (let turn = 0; turn < maxTurns; turn++) {

    const lastRole = agent.history.at(-1)?.role
    if (lastRole === "user" || lastRole === "tool") {
      try {
        if (await compressIfNeeded(agent, threshold, callbacks)) {
          agent._compressFailures = 0
          agent._planReminderAtLen = 0 // After compression history shrinks, reset cadence so reminders resume
          recentCallSigs.length = 0 // After compression history is rebuilt, reset stall detection counter
          callbacks.onCompress?.()
          if (agent.autoApprove && !agent.history.some((m) => m.content === AUTO_REMINDER)) {
            agent.history.push({ role: "user", content: AUTO_REMINDER })
          }
        }
      } catch (compressError) {
        // AbortError must not be swallowed: user cancellation must propagate
        if (compressError?.name === "AbortError" || signal?.aborted) throw compressError
        agent._compressFailures = (agent._compressFailures ?? 0) + 1
        if (agent._compressFailures >= COMPRESS_FAILURE_LIMIT) {
          agent._compressFailures = 0
          if (compressFallback(agent)) callbacks.onCompress?.()
        }
      }
    }

    // Plan-mode reminder cadence: re-inject constraint reminders while plan mode is active
    // (sparse every 2 turns, full every 5 turns or when the user sends a new message),
    // so the read-only restriction never fades from context.
    if (agent.planMode) {
      const lastMsg = agent.history.at(-1)
      const realUserMsg = lastMsg?.role === "user"
        && typeof lastMsg.content === "string"
        && !lastMsg.content.startsWith("[System reminder:")
        && !lastMsg.content.startsWith("[User interrupt:")
      const newUserSince = realUserMsg && agent.history.length > (agent._planReminderAtLen ?? 0)
      const { planReminderForTurn } = await import("./agent-tools/plan.mjs")
      const reminder = planReminderForTurn(agent, newUserSince)
      if (reminder) {
        agent._planReminderAtLen = agent.history.length + 1
        agent.history.push({ role: "user", content: reminder, transient: true })
      }
    }

    // Engineering-mode status injection: every new user message carries a
    // reminder so the model always knows whether it's in design-before-code
    // mode or standard discipline mode.
    if (depth === 0) {
      injectEngineeringReminder(agent)
    }

    const messages = [{ role: "system", content: systemPrompt }, ...agent.history]
    let response

    // Auto-think: classify task difficulty and set reasoning effort before the real prompt.
    // Runs only on turn 0 of user input; failure is silent — falls back to current setting.
    if (agent.config?.agent?.autoThink && turn === 0) {
      const { classifyAndApply } = await import("./auto-think.mjs")
      await classifyAndApply(agent, turn).catch(() => {})
    }

    try {
      response = await chat(agent.provider, {
        messages, tools: toolSchemas,
        onToken: callbacks.onToken,
        onReasoning: callbacks.onReasoning,
        onWait: callbacks.onWait,
        signal,
        streamRules: agent.config.agent?.streamRules ?? [],
        firedPatterns: streamRuleFired,
      })
    } catch (e) {
      // User interrupt (Ctrl+I): controller.abort({ interrupt: true, message: "…" }).
      // Inject the message into history and let the outer loop recreate the controller.
      if (e.name === "AbortError" && signal?.reason?.interrupt) {
        const msg = `[User interrupt: ${signal.reason.message}]`
        // Dedup: if the interrupt was already handled during tool execution (L302-310),
        // don't push a duplicate — the outer loop will still recreate the controller.
        if (agent.history.at(-1)?.content !== msg) {
          agent.history.push({ role: "user", content: msg })
        }
      }
      throw e
    }

    // Stream rule triggered mid-generation (action: "abort"): halt current output,
    // inject rule's message as a reminder, and retry from the same context.
    if (response.ruleTriggered) {
      if (response.content) {
        agent.history.push({ role: "assistant", content: response.content })
      }
      const label = response.ruleName ? ` — stream rule "${response.ruleName}"` : ""
      agent.history.push({
        role: "user",
        content: `[System reminder${label}: ${response.ruleMessage}]`,
      })
      continue
    }

    // Stream rule warnings (action: "warn"): the stream completed, but one or more
    // non-interrupting rules matched. Inject warnings after the turn so the model
    // sees them before its next response — without aborting mid-generation.
    if (response._warnings?.length) {
      const deDuplicated = [...new Map(response._warnings.map(w => [w.name || w.pattern, w])).values()]
      agent.history.push({
        role: "user",
        content: `[System reminder — stream rule warnings from your last response:\n${deDuplicated.map(w => `- ${w.name || w.pattern}: ${w.message}`).join("\n")}]`,
      })
    }

    // User interrupted mid-generation (Ctrl+I): the SSE stream was aborted while content
    // was partially generated. Commit partial output + inject user message, then signal
    // the outer loop to recreate the controller and resume.
    if (response.interrupted) {
      if (response.content) {
        agent.history.push({ role: "assistant", content: response.content })
      }
      agent.history.push({
        role: "user",
        content: `[User interrupt: ${response.interruptMessage}]`,
      })
      throw Object.assign(new Error("User interrupted"), { name: "AbortError" })
    }

    if (response.usage) {
      callbacks.onUsage?.(response.usage)
      if (response.usage.prompt_tokens != null) {
        agent._lastPromptTokens = response.usage.prompt_tokens
        agent._usageAtLen = agent.history.length
      }
    }

    // Warn on abnormal finish reasons — the model stopped for a reason other than
    // "stop" or "tool_calls", meaning the response may be incomplete or truncated.
    if (response.finishReason && response.finishReason !== "stop" && response.finishReason !== "tool_calls") {
      const reasonMap = {
        length: "output token limit reached after exhausting continuations",
        insufficient_system_resource: "provider inference resources exhausted — consider retrying or switching models",
        content_filter: "response blocked by provider content filtering",
      }
      const detail = reasonMap[response.finishReason] || `unknown reason "${response.finishReason}"`
      agent.history.push({
        role: "user",
        content: `[System reminder: the previous turn ended abnormally — ${detail}. The assistant response that follows may be incomplete.]`,
      })
    }

    if (response.toolCalls.length === 0) {
      const cr = handleCompletion(agent, response, depth, turn, guardPushbacks, honestReminderInjected, advisorPushbacks, callbacks)
      guardPushbacks = cr.guardPushbacks
      honestReminderInjected = cr.honestReminderInjected
      advisorPushbacks = cr.advisorPushbacks
      if (cr.action === "continue") continue
      return cr.content
    }

    // abort after chat completes, before committing history: don't commit a half-finished turn
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    agent.history.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
      ...(response.reasoning && specForModel(agent.provider.model).reasoningEcho === "required"
        ? { reasoning_content: response.reasoning }
        : {}),
    })

    const results = await executeToolCalls(agent, toolByName, response.toolCalls, callbacks, depth, signal)

    // Ctrl+I interrupt during tool execution: skip committing partial results —
    // the tool failure messages would mislead the model. Inject the interrupt and retry.
    if (signal?.reason?.interrupt) {
      agent.history.push({
        role: "user",
        content: `[User interrupt: ${signal.reason.message}]`,
      })
      callbacks.onTurnEnd?.(agent, turn)
      continue
    }

    // Model is executing tools → doing real work, reset guard pushback counter
    guardPushbacks = 0
    advisorPushbacks = 0

    for (const { toolCall, result, ok } of results) {
      const tool = toolByName.get(toolCall.name)
      // Multimodal tools return JSON { text, images } — inject as multimodal user message
      if (tool?.multimodal && ok) {
        try {
          const parsed = JSON.parse(result)
          if (parsed.images?.length) {
            // tool message first — closes the tool_call pairing (OpenAI API requires tool result immediately after assistant with tool_calls)
            agent.history.push({ role: "tool", tool_call_id: toolCall.id, content: parsed.text })
            if (specForModel(agent.provider.model).multimodal) {
              // then inject multimodal user message with base64 images for the model to actually "see" them on the next turn
              agent.history.push({
                role: "user",
                content: [{ type: "text", text: parsed.text }, ...parsed.images],
              })
            } else {
              // Non-vision model: image parts must never enter history — text-only APIs 400 on them on EVERY
              // subsequent request, poisoning the conversation. (read_image itself already refuses; this is defense-in-depth.)
              agent.history.push({
                role: "user",
                content: `[System reminder: the image returned by ${toolCall.name} was NOT injected — model ${agent.provider.model} does not support image input. Do not call ${toolCall.name} again under this provider; verify visual output programmatically instead.]`,
              })
            }
            continue
          }
        } catch { /* Parse failure doesn't affect normal tool messages */ }
      }
      agent.history.push({ role: "tool", tool_call_id: toolCall.id, content: result })
      if (tool && ok) {
        if (!tool.readonly && !tool.sideEffectExempt) {
          agent._mutatedThisRun = true
          // Any mutation after advisor or verify invalidates the prior review/verification
          if (agent._calledAdvisorThisRun) agent._calledAdvisorThisRun = false
          if (agent._verifiedThisRun) {
            agent._verifiedThisRun = false
            agent._verifyPassed = undefined
          }
        }
        if (toolCall.name === "verify") agent._verifiedThisRun = true
        if (toolCall.name === "advisor") {
          agent._calledAdvisorThisRun = true
          // Design reviews are a separate gate with no convergence protocol —
          // they must not consume code-review rounds (MAX_ADVISOR_ROUNDS budget).
          // Always advance the round — the convergence protocol cares about
          // how many reviews have run (round 1→2→3→4→5), not how many succeeded.
          // A failed/interrupted review is still a review attempt and should use
          // the next round's prompt on retry.
          try {
            const advArgs = JSON.parse(toolCall.arguments || "{}")
            if (advArgs.type !== "design") agent._advisorRound++
          } catch {
            agent._advisorRound++
          }
        }
        if (FILE_MUTATORS.has(toolCall.name)) {
          const args = JSON.parse(toolCall.arguments)
          const paths = tool.touchedPaths ? tool.touchedPaths(args) : [args.path]
          for (const p of paths) {
            const abs = join(agent.cwd, p)
            if (!agent._touchedFiles.includes(abs)) agent._touchedFiles.push(abs)
            if (agent.memory) {
              // Fire-and-forget: don't block the agent loop on indexing.
              // Reuses a single cached import; errors surface as pending reminders on next turn.
              if (!_reindexFile) {
                const mod = await import("./memory.mjs")
                _reindexFile = mod.reindexFile
              }
              _reindexFile(agent.memory, agent.cwd, abs).catch((e) => {
                agent._pendingReminders.push(`[System reminder: background indexing failed for ${toolCall.name} on ${abs}: ${e.message}. This does not affect your work — the code index will catch up on next reindex.]`)
              })
            }
          }
        }
      }
    }

    injectPostTurn(agent, results, recentCallSigs, callbacks, turn)
  }

  throw new ContinueError(maxTurns)
}
