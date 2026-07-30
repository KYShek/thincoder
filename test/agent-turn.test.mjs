/**
 * agent-turn.mjs tests — 队列逐条处理（runAgentTurn 尾部 while 循环）。
 * runAgent / saveSession 经 ctx 注入 mock，不触网、不写盘。
 * createCheckpoint 对非 git 的临时 cwd 直接返回 null（只读检查）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runAgentTurn } from "../src/tui/agent-turn.mjs"

/** Minimal ctx mock：记录 runAgent / handleSlash / saveSession 调用。 */
function turnCtx(overrides = {}) {
  const agent = {
    cwd: mkdtempSync(join(tmpdir(), "thincoder-turn-")),
    provider: { model: "test-model" },
    history: [],
    config: {},
    tasks: [],
    tools: [],
  }
  const state = {
    lines: [], streaming: "", reasoning: "",
    subTasks: {}, toolStreams: {}, outputPanels: {},
    tasks: [], queue: [],
    processing: false, controller: null, interruptPrompt: null,
    permission: null, currentTool: null, processingStarted: 0,
    status: "Ready",
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0 },
  }
  const ctx = {
    agent, state,
    calls: { runAgent: [], slash: [], saved: 0 },
    lines: [],
    pushLine: (text) => ctx.lines.push({ kind: "line", text }),
    pushLabel: (text) => ctx.lines.push({ kind: "label", text }),
    render: () => {},
    scheduleRender: () => {},
    ensureAssistantLabel: () => {},
    askPermission: async () => true,
    askQuestion: async () => "",
    handleSlash: async (text) => { ctx.calls.slash.push(text) },
    summarize: () => "",
    runAgent: async (_agent, text) => { ctx.calls.runAgent.push(text) },
    saveSession: () => { ctx.calls.saved++ },
    ...overrides,
  }
  return ctx
}

const cleanups = []
test.after(() => { for (const dir of cleanups) rmSync(dir, { recursive: true, force: true }) })
function trackedCtx(overrides) {
  const ctx = turnCtx(overrides)
  cleanups.push(ctx.agent.cwd)
  return ctx
}

test("runAgentTurn: 纯斜杠队列逐条走 handleSlash，不再发给 LLM", async () => {
  const ctx = trackedCtx()
  ctx.state.queue.push({ text: "/fold on" }, { text: "/clear" })
  await runAgentTurn(ctx, "hello")
  assert.deepEqual(ctx.calls.runAgent, ["hello"], "只有首条用户输入发给 LLM")
  assert.deepEqual(ctx.calls.slash, ["/fold on", "/clear"], "队列逐条检查，全部走 handleSlash")
  assert.equal(ctx.state.queue.length, 0)
  assert.equal(ctx.state.processing, false)
})

test("runAgentTurn: 混合队列按序执行——斜杠命令不发 LLM，普通消息递归新一轮", async () => {
  const ctx = trackedCtx()
  ctx.state.queue.push({ text: "/fold on" }, { text: "second task" }, { text: "/clear" })
  await runAgentTurn(ctx, "first task")
  assert.deepEqual(ctx.calls.runAgent, ["first task", "second task"], "普通消息才发给 LLM")
  assert.deepEqual(ctx.calls.slash, ["/fold on", "/clear"], "斜杠命令走 handleSlash")
  const queueLabels = ctx.lines.filter((l) => l.kind === "label" && /from queue/.test(l.text))
  assert.equal(queueLabels.length, 1, "队列消息带 (from queue) 标签")
  assert.equal(ctx.state.queue.length, 0)
})

test("runAgentTurn: handleSlash 期间新入队项继续被消费且不重复", async () => {
  const ctx = trackedCtx({
    handleSlash: async (text) => {
      ctx.calls.slash.push(text)
      // 模拟 handleSlash 执行期间用户又排队了新消息
      if (text === "/a") ctx.state.queue.push({ text: "/b" }, { text: "follow up" })
    },
  })
  ctx.state.queue.push({ text: "/a" })
  await runAgentTurn(ctx, "start")
  assert.deepEqual(ctx.calls.slash, ["/a", "/b"], "新入队的斜杠命令各执行一次")
  assert.deepEqual(ctx.calls.runAgent, ["start", "follow up"], "新入队的普通消息各执行一次")
  assert.equal(ctx.state.queue.length, 0, "队列被完全消费，无重复无遗漏")
})
