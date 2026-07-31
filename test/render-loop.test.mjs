/**
 * render-loop.mjs tests — row-diff rendering of the output panel.
 * Frames are captured via the injected write function (no process.stdout mock).
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { createRenderLoop } from "../src/tui/render-loop.mjs"

function makeHarness() {
  const writes = []
  const origCols = process.stdout.columns
  const origRows = process.stdout.rows
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
  const { render } = createRenderLoop(state, agent, ctx, () => {}, (s) => writes.push(String(s)))
  return {
    state, render,
    output: () => writes.join(""),
    restore: () => {
      process.stdout.columns = origCols
      process.stdout.rows = origRows
    },
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** Mirror of agent-turn.mjs onToolOutput */
function feedChunk(state, name, chunk) {
  let panel = state.outputPanels[name]
  if (!panel) { state.outputPanels[name] = { parts: [], len: 0, done: false }; panel = state.outputPanels[name] }
  const part = typeof chunk === "string" ? { kind: "text", text: chunk } : { kind: chunk.kind ?? "text", text: String(chunk.text ?? "") }
  panel.parts.push(part)
  panel.len += part.text.length
  while (panel.len > 4000 && panel.parts.length > 1) {
    const first = panel.parts[0]
    const excess = panel.len - 4000
    if (first.text.length <= excess) { panel.len -= first.text.length; panel.parts.shift() }
    else { first.text = first.text.slice(excess); panel.len -= excess }
  }
}

test("output panel: streamed content is drawn and keeps updating past the 4000-char cap", async () => {
  const h = makeHarness()
  try {
    h.state.outputPanels.bash = { parts: [], len: 0, done: false }
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
    // (regression: the old incremental cache keyed on text length, which froze at the cap).
    assert.ok(/output-line-[45]\d\d/.test(out), "content well past the 4000-char cap still drawn (no freeze)")
    assert.ok(out.includes("output-line-600"), "final lines drawn")
  } finally {
    h.restore()
  }
})

test("output panel: done panel keeps its content during the closeAt grace, then is pruned", async () => {
  const h = makeHarness()
  try {
    h.state.outputPanels.bash = { parts: [], len: 0, done: false }
    h.render()
    await tick()
    feedChunk(h.state, "bash", "build-ok\n")
    // onToolResult path: done + close grace
    h.state.outputPanels.bash.done = true
    h.state.outputPanels.bash.closeAt = Date.now() + 60_000
    h.render()
    await tick(60)
    assert.ok(h.output().includes("build-ok"), "final content still visible during grace")
    assert.ok(h.state.outputPanels.bash, "panel not pruned during grace")

    // Expire the grace — next render prunes the panel and repaints without it
    h.state.outputPanels.bash.closeAt = Date.now() - 1
    h.render()
    await tick(60)
    assert.equal(h.state.outputPanels.bash, undefined, "panel pruned after grace")
  } finally {
    h.restore()
  }
})
