/**
 * completion.mjs tests — handleCompletion empty-response recovery.
 * Empty responses (reasoning exhausted / truncated output) must inject a retry
 * reminder instead of aborting the whole turn; after MAX_EMPTY_RETRIES (2)
 * consecutive empties the original error surfaces.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { handleCompletion } from "../src/agent/completion.mjs"

function baseAgent(overrides = {}) {
  return {
    history: [],
    tasks: [],
    config: { agent: {}, advisor: { enabled: false } },
    provider: { model: "test-model" },
    _mutatedThisRun: false,
    _touchedFiles: [],
    ...overrides,
  }
}

const baseResponse = { content: "ok", toolCalls: [], finishReason: "stop" }
const emptyResponse = { content: null, toolCalls: [], finishReason: "stop" }

test("handleCompletion: empty response injects retry reminder and continues", () => {
  const agent = baseAgent()
  const turned = []
  const cr = handleCompletion(agent, emptyResponse, 0, 0, 0, false, 0, { onTurnEnd: (a, t) => turned.push(t) })
  assert.equal(cr.action, "continue")
  assert.equal(agent._emptyRetries, 1)
  assert.deepEqual(turned, [0], "onTurnEnd called so the loop can continue")
  const last = agent.history.at(-1)
  assert.equal(last.role, "user")
  assert.ok(last.content.startsWith("[System reminder: your last response was empty"), last.content)
  // Empty retry reminder is machine-only — the human-readable line stays untouched
  assert.equal(agent._fullHistory, undefined)
})

test("handleCompletion: empty response does not consume verify/advisor pushback budget", () => {
  const agent = baseAgent()
  const cr = handleCompletion(agent, emptyResponse, 0, 0, 2, false, 3, {})
  assert.equal(cr.guardPushbacks, 2)
  assert.equal(cr.advisorPushbacks, 3)
})

test("handleCompletion: consecutive empties exceed budget and throw the original error", () => {
  const agent = baseAgent()
  assert.equal(handleCompletion(agent, emptyResponse, 0, 0, 0, false, 0, {}).action, "continue")
  assert.equal(handleCompletion(agent, emptyResponse, 0, 1, 0, false, 0, {}).action, "continue")
  assert.throws(
    () => handleCompletion(agent, emptyResponse, 0, 2, 0, false, 0, {}),
    /LLM returned empty response.*test-model/,
  )
  assert.equal(agent._emptyRetries, 2, "budget exhausted at 2 retries")
})

test("handleCompletion: retry budget resets per run (fresh agent object)", () => {
  const a1 = baseAgent()
  handleCompletion(a1, emptyResponse, 0, 0, 0, false, 0, {})
  const a2 = baseAgent()
  const cr = handleCompletion(a2, emptyResponse, 0, 0, 0, false, 0, {})
  assert.equal(cr.action, "continue", "a fresh agent gets a fresh budget")
})

test("handleCompletion: non-empty response unaffected (normal completion path)", () => {
  const agent = baseAgent()
  const cr = handleCompletion(agent, baseResponse, 0, 0, 0, false, 0, {})
  assert.equal(cr.action, "done")
  assert.equal(cr.content, "ok")
  assert.deepEqual(agent.history.at(-1), { role: "assistant", content: "ok" }, "real response committed via pushReal")
  assert.deepEqual(agent._fullHistory.at(-1), { role: "assistant", content: "ok" }, "and mirrored to the human-readable line")
})

test("handleCompletion: pending tasks still take priority over empty retry? no — empty check first", () => {
  // The empty check is the first gate: a model that returned nothing cannot be
  // reminded about tasks, so the retry reminder wins over the pending-task reminder.
  const agent = baseAgent({ tasks: [{ title: "T1", status: "pending" }] })
  const cr = handleCompletion(agent, emptyResponse, 0, 0, 0, false, 0, {})
  assert.equal(cr.action, "continue")
  const last = agent.history.at(-1)
  assert.ok(last.content.startsWith("[System reminder: your last response was empty"), last.content)
})

test("handleCompletion: pending-task pushback fires at most ONCE (no unbounded loop)", () => {
  const agent = baseAgent({ tasks: [{ title: "T1", status: "pending" }] })
  // First completion attempt with pending → one reminder, continue
  const cr1 = handleCompletion(agent, baseResponse, 0, 0, 0, false, 0, {})
  assert.equal(cr1.action, "continue")
  assert.equal(agent._taskPushbacks, 1)
  const last = agent.history.at(-1)
  assert.ok(last.content.startsWith("[System reminder: you still have pending tasks: T1"), last.content)
  assert.ok(last.content.includes("only reminder"), "copy says it is the only reminder")

  // Second completion attempt → model is free to finish (no second pushback)
  const cr2 = handleCompletion(agent, baseResponse, 0, 1, 0, false, 0, {})
  assert.equal(cr2.action, "done", "second attempt is not pushed back")
  assert.equal(cr2.content, "ok")
})

test("handleCompletion: updating the task list resets the pushback budget", async () => {
  const agent = baseAgent({ tasks: [{ title: "T1", status: "pending" }] })
  handleCompletion(agent, baseResponse, 0, 0, 0, false, 0, {})
  assert.equal(agent._taskPushbacks, 1)
  // Task tool updates the list (statuses changed) → fresh budget
  const { taskTool } = await import("../src/agent-tools/task.mjs")
  taskTool.execute({ items: [{ title: "T1", status: "in_progress" }, { title: "T2", status: "pending" }] }, { agent })
  assert.equal(agent._taskPushbacks, 0, "task update resets the counter")
  const cr = handleCompletion(agent, baseResponse, 0, 1, 0, false, 0, {})
  assert.equal(cr.action, "continue", "fresh list state earns one reminder again")
  assert.equal(agent._taskPushbacks, 1)
})

test("handleCompletion: no pending tasks → no pushback, no counter touched", () => {
  const agent = baseAgent({ tasks: [{ title: "D1", status: "done" }] })
  const cr = handleCompletion(agent, baseResponse, 0, 0, 0, false, 0, {})
  assert.equal(cr.action, "done")
  assert.equal(agent._taskPushbacks ?? 0, 0)
})

