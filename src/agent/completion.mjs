/**
 * agent/completion.mjs — handle model response with no tool calls
 *
 * Checks: pending tasks, verify guard, advisor guard.
 * Returns { action: 'continue' | 'done', content?, guardPushbacks, honestReminderInjected, advisorPushbacks }
 */
import { isDocFile } from "../advisor/repos.mjs"

/** True when this run mutated at least one CODE file. Mirrors agent.mjs:hasCodeMutations. */
function hasCodeMutations(agent) {
  const files = agent._touchedFiles ?? []
  if (files.length === 0) return agent._mutatedThisRun
  return files.some((p) => /(?:^|[\\/])src[\\/]/.test(p) || !isDocFile(p))
}

const MAX_VERIFY_PUSHBACKS = 2
const MAX_VERIFY_RETRIES = 3
const MAX_ADVISOR_PUSHBACKS = 3

/**
 * Handle a model turn with zero tool calls. May push back (verify/advisor/pending tasks)
 * or accept the completion.
 *
 * @param {object} agent
 * @param {object} response - chat response with .content, .toolCalls
 * @param {number} depth - agent nesting depth (0 = top-level)
 * @param {number} turn - current turn index
 * @param {number} guardPushbacks - verify guard pushback count (mutated)
 * @param {boolean} honestReminderInjected - whether exhausted-verify reminder was already sent (mutated)
 * @param {number} advisorPushbacks - advisor guard pushback count (mutated)
 * @param {object} callbacks - { onTurnEnd }
 */
export function handleCompletion(agent, response, depth, turn, guardPushbacks, honestReminderInjected, advisorPushbacks, callbacks) {
  if (!response.content) {
    throw new Error(
      "LLM returned empty response (likely reasoning exhausted or output truncated). " +
      "Try lowering reasoning effort if this persists (/think in TUI). " +
      `Provider: ${agent.provider.model}`
    )
  }

  // Pending tasks: remind the model before it declares itself done
  if (depth === 0 && agent.tasks.some((t) => t.status === "pending")) {
    const pending = agent.tasks.filter((t) => t.status === "pending").map((t) => t.title).join(", ")
    agent.history.push({ role: "assistant", content: response.content })
    agent.history.push({
      role: "user",
      content: `[System reminder: you still have pending tasks: ${pending}. Update their status with the task tool before finishing — if they're done, mark them done; if they're not applicable, remove them.]`,
    })
    callbacks.onTurnEnd?.(agent, turn)
    return { action: "continue", guardPushbacks, honestReminderInjected, advisorPushbacks }
  }

  // --- verify guard: push model to verify mutated files before completion ---
  // OPT-IN ONLY (verifyGuard: true). Engineering mode is excluded because it
  // uses flow-driven review, not per-turn mechanical pushback (ENGINEERING-MODE.md §2.3).
  // Backward compat: also accept root-level verifyGuard
  const verifyGuard = agent.config?.agent?.verifyGuard ?? agent.config?.verifyGuard
  if (depth === 0 && verifyGuard === true && !agent.config?.agent?.engineering) {
    // Not verified yet → pushback to run verify
    if (agent._mutatedThisRun && !agent._verifiedThisRun && hasCodeMutations(agent) && guardPushbacks < MAX_VERIFY_PUSHBACKS) {
      guardPushbacks++
      agent.history.push({ role: "assistant", content: response.content })
      agent.history.push({
        role: "user",
        content: "[System reminder: you modified files in this run but have not verified the changes. Before finishing: call the verify tool to run syntax checks and tests. If verify reports failures, fix them and run verify again. If verification is genuinely impossible here, say so explicitly in your reply.]",
      })
      callbacks.onTurnEnd?.(agent, turn)
      return { action: "continue", guardPushbacks, honestReminderInjected, advisorPushbacks }
    }
    // Verified but still failing → pushback to fix (up to MAX_VERIFY_RETRIES)
    if (agent._verifiedThisRun && agent._verifyPassed === false && agent._verifyRetries < MAX_VERIFY_RETRIES) {
      agent._verifyRetries++
      agent.history.push({ role: "assistant", content: response.content })
      agent.history.push({
        role: "user",
        content: `[System reminder: verify reported test failures (retry ${agent._verifyRetries}/${MAX_VERIFY_RETRIES}). Review the failures, fix the issues, then run verify again. If you cannot fix after ${MAX_VERIFY_RETRIES} attempts, explain honestly what's blocking you.]`,
      })
      callbacks.onTurnEnd?.(agent, turn)
      return { action: "continue", guardPushbacks, honestReminderInjected, advisorPushbacks }
    }
    // Exhausted retries — inject honesty reminder once
    if (agent._verifiedThisRun && agent._verifyPassed === false && agent._verifyRetries >= MAX_VERIFY_RETRIES) {
      if (honestReminderInjected) {
        agent.history.push({ role: "assistant", content: response.content })
        return { action: "done", content: response.content, guardPushbacks, honestReminderInjected, advisorPushbacks }
      }
      honestReminderInjected = true
      agent.history.push({ role: "assistant", content: response.content })
      agent.history.push({
        role: "user",
        content: `[System reminder: ${MAX_VERIFY_RETRIES} verify attempts exhausted and tests are still failing. In your response to the user, you MUST state explicitly: (1) what tests are still failing, (2) what you tried, (3) what you believe the root cause is. Do not present this as complete — the user needs to know the work is unfinished.]`,
      })
      callbacks.onTurnEnd?.(agent, turn)
      return { action: "continue", guardPushbacks, honestReminderInjected, advisorPushbacks }
    }
  }

  // --- advisor guard: review of mutated files before completion ---
  // OPT-IN via advisor.enabled + guard!==false, and NEVER in engineering mode.
  const cfg = agent.config?.advisor
  const advisorReview = cfg?.enabled && cfg?.guard !== false
  if (depth === 0 && advisorReview && !agent.config?.agent?.engineering) {
    if (agent._mutatedThisRun && !agent._calledAdvisorThisRun && hasCodeMutations(agent)
        && advisorPushbacks < MAX_ADVISOR_PUSHBACKS) {
      advisorPushbacks++
      agent.history.push({ role: "assistant", content: response.content })
      agent.history.push({
        role: "user",
        content: `[System reminder: you changed code in this run and MUST get an advisor review before finishing (round ${agent._advisorRound + 1}). Call the \`advisor\` tool now. This is required, not optional — do not skip it even if you believe the changes are trivial — the review will be quick either way. After the review, produce a response table for every issue found (see discipline rules for format).]`,
      })
      callbacks.onTurnEnd?.(agent, turn)
      return { action: "continue", guardPushbacks, honestReminderInjected, advisorPushbacks }
    }
  }

  agent.history.push({ role: "assistant", content: response.content })
  return { action: "done", content: response.content, guardPushbacks, honestReminderInjected, advisorPushbacks }
}
