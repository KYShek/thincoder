/**
 * render-loop.mjs tests — output panel incremental rendering.
 * process.stdout.write is mocked to capture frames; columns/rows are stubbed.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { createRenderLoop } from "../src/tui/render-loop.mjs"

function makeHarness() {
  const writes = []
  const origWrite = process.stdout.write
  const origCols = process.stdout.columns
  const origRows = process.stdout.rows
  // Spy, don't swallow: forward to the real write so the test runner's own
  // reporting (which also goes through process.stdout) is not eaten.
  process.stdout.write = (s, ...rest) => { writes.push(String(s)); return origWrite.call(process.stdout, s, ...rest) }
  process.stdout.columns = 80
  process.stdout.rows = 24
  const state = {
    lines: [], input: [], cursor: 0, history: [], historyIndex: -1, scroll: 0,
    processing: true, controller: null, interruptPrompt: null,
    permission: null, permissionPreview: [], question: null,
    picker: null, wizard: null, tasks: [],
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0 },
    ctxCache: { len: -1, tokens: 0 }, reasoning: "", streaming: "",
    toolStreams: {}, subTasks: {}, outputPanels: {},
    currentTool: null, processingStarted: Date.now(), status: "Processing...", queue: [],
  }
  const agent = { provider: { model: "m" }, cwd: "/t", planMode: false, autoApprove: true, config: {}, history: [], tasks: [] }
  const ctx = { startupDims: { cols: 80, rows: 24 }, SLASH_COMMANDS: [], pendingNoticeReady: () => false, showUpdateNotice: async () => {} }
  const { render, scheduleRender } = createRenderLoop(state, agent, ctx, () => {})
  return {
    state, render,
    output: () => writes.join(""),
    restore: () => {
      process.stdout.write = origWrite
      process.stdout.columns = origCols
      process.stdout.rows = origRows
    },
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Mirror of agent-turn.mjs onToolOutput */
function feedChunk(state, name, chunk) {
  let panel = state.outputPanels[name]
  if (!panel) { state.outputPanels[name] = { text: "", done: false }; panel = state.outputPanels[name] }
  panel.text = (panel.text ?? "") + chunk
  if (panel.text.length > 4000) panel.text = panel.text.slice(-4000)
  panel.seq = (panel.seq ?? 0) + 1
}

test("output panel: streamed content is drawn and keeps updating past the 4000-char cap", async () => {
  const h = makeHarness()
  try {
    h.state.outputPanels.bash = { text: "", done: false }
    h.render()
    await tick()
    for (let i = 1; i <= 600; i++) {
      feedChunk(h.state, "bash", `output-line-${i}\n`)
      h.render()
      if (i % 10 === 0) await tick(20) // ~1 paint per 10 lines; tail window is 8 lines
    }
    await tick(60)
    const out = h.output()
    assert.ok(out.includes("output-line-10"), "early content drawn")
    // The 4000-char text cap is hit around line ~270; content past it must still repaint
    // (regression: cache key used text length, which freezes at the cap).
    assert.ok(/output-line-[45]\d\d/.test(out), "content well past the 4000-char cap still drawn (no freeze)")
    assert.ok(out.includes("output-line-600"), "final lines drawn")
  } finally {
    h.restore()
  }
})

test("output panel: final frame flushes before done flag collapses the panel", async () => {
  const h = makeHarness()
  try {
    h.state.outputPanels.bash = { text: "", done: false }
    h.render()
    await tick()
    feedChunk(h.state, "bash", "build-ok\n")
    // onToolResult path: defer done until the next render flushes it
    h.state.outputPanels.bash._pendingDone = true
    h.render()
    await tick(60)
    assert.ok(h.output().includes("build-ok"), "final chunk visible before collapse")
    assert.equal(h.state.outputPanels.bash.done, true, "done flag flipped after the flush render")
  } finally {
    h.restore()
  }
})
