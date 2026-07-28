/**
 * TUI pure function tests — rendering, layout, keyboard handling.
 * No terminal needed — all functions are pure.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { stringWidth, wrapText } from "../src/tui/render.mjs"
import { computeLayout } from "../src/tui/layout.mjs"
import { renderFrame } from "../src/tui/render-frame.mjs"
import { createKeyHandler } from "../src/tui/key-handler.mjs"

// ====================================================================
// render.mjs — stringWidth, wrapText, sanitizeDisplay, formatTables
// ====================================================================

test("stringWidth: ascii / cjk / emoji", () => {
  assert.equal(stringWidth("hello"), 5)
  assert.equal(stringWidth("你好"), 4)
  assert.equal(stringWidth("a你b"), 4)
  assert.equal(stringWidth("🔧"), 2)
})

test("wrapText: 按宽度折行，保留空行", () => {
  assert.deepEqual(wrapText("abcdefgh", 3), ["abc", "def", "gh"])
  assert.deepEqual(wrapText("你好吗朋友", 4), ["你好", "吗朋", "友"])
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"])
})

test("sanitizeDisplay: 控制字符不破坏终端网格（\\r 覆盖、\\t 超宽、ANSI/响铃冲屏）", async () => {
  const { sanitizeDisplay } = await import("../src/tui/render.mjs")
  assert.equal(sanitizeDisplay("1\tconst a = 1;\r"), "1    const a = 1;")
  assert.equal(sanitizeDisplay("abc\rdef"), "abc\ndef")
  assert.equal(sanitizeDisplay("a\r\nb"), "a\nb")
  assert.equal(sanitizeDisplay("12\tx"), "12    x")
  assert.equal(sanitizeDisplay("\x1b[31mred\x1b[0m"), "red")
  assert.equal(sanitizeDisplay("\x1b[2Aup"), "up")
  assert.equal(sanitizeDisplay("bell\x07end"), "bellend")
  assert.equal(sanitizeDisplay("a\x00\x08\x0b\x7fb"), "ab")
  assert.equal(sanitizeDisplay("正常文本 normal text"), "正常文本 normal text")
})

test("layoutInput: 折行与光标定位", async () => {
  const { layoutInput } = await import("../src/tui/render.mjs")
  // empty input still produces one line (has prompt "▸ ")
  const empty = layoutInput([], 0, 10)
  assert.equal(empty.lines.length, 1)
  assert.equal(empty.cursorCol, 2)
  const lay = layoutInput([..."hello"], 5, 10)
  assert.equal(lay.lines.length, 1)
  const lay2 = layoutInput([..."0123456789abcdef"], 16, 5)
  assert.ok(lay2.lines.length > 1, "long input wraps")
})

test("formatTables: CJK 表格按显示宽度对齐", async () => {
  const { formatTables } = await import("../src/tui/render.mjs")
  const table = "| 名称 | 描述 |\n|---|---|\n| 你好 | hello |"
  const result = formatTables(table, 40)
  assert.ok(result.join("\n").includes("hello"), "table preserved")
})

test("formatTables: 超宽表格按列收缩到可用宽度", async () => {
  const { formatTables } = await import("../src/tui/render.mjs")
  const table = "| a | b | c | d | e | f | g | h | i | j |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |"
  const result = formatTables(table, 20)
  assert.ok(result.length > 0, "produces output even if narrow")
})

// ====================================================================
// layout.mjs — computeLayout
// ====================================================================

/** Build a minimal state object for TUI tests. */
function tuiState(overrides = {}) {
  return {
    lines: [], streaming: "", input: [], cursor: 0,
    history: [], historyIndex: -1, scroll: 0,
    processing: false, controller: null,
    permission: null, permissionPreview: [], question: null,
    picker: null, wizard: null, tasks: [],
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 },
    ctxCache: { len: -1, tokens: 0 }, reasoning: "",
    toolStreams: {}, subTasks: {}, outputPanels: {},
    currentTool: null, processingStarted: 0, status: "Ready", queue: [],
    ...overrides,
  }
}

/** Minimal agent mock for renderFrame */
function tuiAgent(overrides = {}) {
  return {
    provider: { model: "deepseek-chat", apiKey: "sk-test", baseURL: "https://test" },
    cwd: "/home/test/project",
    autoApprove: false, planMode: false,
    config: { agent: { compactThreshold: 100_000 } },
    tasks: [],
    ...overrides,
  }
}

test("computeLayout: basic layout with all panels", () => {
  const state = tuiState()
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.ok(layout.panels.header, "header exists")
  assert.equal(layout.panels.header.h, 1)
  assert.ok(layout.panels.conversation, "conversation exists")
  assert.ok(layout.panels.conversation.h > 0, "conversation gets remaining space")
  assert.ok(layout.panels.inputBox, "input box exists")
  assert.ok(layout.panels.status, "status bar exists")
  assert.equal(layout.panels.status.h, 1)
  assert.equal(layout.panels.todo, null)
  assert.equal(layout.panels.subagent, null)
  assert.equal(layout.panels.output, null)
  assert.equal(layout.panels.permission, null)
  assert.equal(layout.panels.queue, null)
})

test("computeLayout: tasks panel visible with tasks", () => {
  const state = tuiState({
    tasks: [
      { title: "task A", status: "done" },
      { title: "task B", status: "in_progress" },
      { title: "task C", status: "pending" },
    ],
  })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.ok(layout.panels.todo, "todo panel visible")
  assert.equal(layout.panels.todo.h, 3)
  assert.equal(layout.visibleTasks.length, 3)
})

test("computeLayout: tasks truncated at 5, in_progress prioritized", () => {
  const state = tuiState({
    tasks: [
      { title: "task 1", status: "done" },
      { title: "task 2", status: "done" },
      { title: "task 3", status: "done" },
      { title: "task 4", status: "done" },
      { title: "task 5", status: "pending" },
      { title: "task 6", status: "in_progress" },
      { title: "task 7", status: "pending" },
    ],
  })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.equal(layout.visibleTasks.length, 5, "capped at 5")
  assert.equal(layout.visibleTasks[0].title, "task 6")
  assert.equal(layout.visibleTasks[0].status, "in_progress")
})

test("computeLayout: subagent panel visible when processing", () => {
  const state = tuiState({
    processing: true,
    subTasks: { "explore#1": { key: "explore#1", role: "explore", text: "searching...", done: false } },
  })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.ok(layout.panels.subagent, "subagent panel visible")
  assert.equal(layout.allSubs.length, 1)
})

test("computeLayout: panel ordering — subagent before todo", () => {
  const state = tuiState({
    processing: true,
    subTasks: { "coder#1": { key: "coder#1", role: "coder", text: "editing...", done: false } },
    tasks: [{ title: "task 1", status: "in_progress" }],
  })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.ok(layout.panels.subagent, "subagent exists")
  assert.ok(layout.panels.todo, "todo exists")
  assert.ok(layout.panels.subagent.y < layout.panels.todo.y, `subagent.y=${layout.panels.subagent.y} should be < todo.y=${layout.panels.todo.y}`)
})

test("computeLayout: output panels visible", () => {
  const state = tuiState({ outputPanels: { bash: { text: "line1\nline2", done: false } } })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.ok(layout.panels.output, "output panel visible")
  assert.ok(layout.panels.output.h > 0)
})

test("computeLayout: done output panels excluded", () => {
  const state = tuiState({ outputPanels: { bash: { text: "done", done: true } } })
  const layout = computeLayout(state, { cols: 80, rows: 24 })
  assert.equal(layout.panels.output, null, "done panels excluded")
})

// ====================================================================
// render-frame.mjs — renderFrame
// ====================================================================

test("renderFrame: produces ANSI frame with header", () => {
  const state = tuiState()
  const agent = tuiAgent()
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("ThinCoder"), "frame has ThinCoder header")
  assert.ok(frame.includes("deepseek-chat"), "frame has model name")
  assert.ok(frame.includes("project"), "frame has cwd basename")
})

test("renderFrame: cursor returns to input position in normal mode", () => {
  const state = tuiState({ input: [..."hello"] })
  const agent = tuiAgent()
  const { frame, cursorRow, cursorCol } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(cursorRow > 0, "cursorRow > 0")
  assert.ok(cursorCol > 0, "cursorCol > 0")
  assert.ok(frame.length > 0)
})

test("renderFrame: cursor hidden in permission mode", () => {
  const state = tuiState({
    permission: { name: "write", resolve: () => {} },
    permissionPreview: ["/tmp/test.js (123 bytes)"],
  })
  const agent = tuiAgent()
  const { frame, cursorRow } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("Permission Request"), "frame shows permission header")
  assert.equal(cursorRow, 0, "cursorRow 0 in permission mode (hidden)")
})

test("renderFrame: todo marks show correct status icons", () => {
  const state = tuiState({
    tasks: [
      { title: "done task", status: "done" },
      { title: "in-progress task", status: "in_progress" },
      { title: "pending task", status: "pending" },
    ],
  })
  const agent = tuiAgent()
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("✓ done task"), "done task has checkmark")
  assert.ok(frame.includes("▶ in-progress task"), "in_progress has triangle")
  assert.ok(frame.includes("○ pending task"), "pending has circle")
})

test("renderFrame: subagent panel shows role and status", () => {
  const state = tuiState({
    processing: true,
    subTasks: {
      "coder#1": { key: "coder#1", role: "coder", text: "", tool: "write", toolArgs: { path: "file.mjs" }, done: false, started: Date.now() },
    },
  })
  const agent = tuiAgent()
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("[coder]"), "subagent panel shows role")
  assert.ok(frame.includes("write"), "shows current tool")
})

test("renderFrame: status bar shows task progress", () => {
  const state = tuiState({
    tasks: [
      { title: "task 1", status: "done" },
      { title: "task 2", status: "in_progress" },
      { title: "task 3", status: "pending" },
    ],
  })
  const agent = tuiAgent()
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("✓1/3"), "status bar shows 1/3 done")
})

test("renderFrame: AUTO and PLAN banners visible", () => {
  const state = tuiState()
  const agent = tuiAgent({ autoApprove: true, planMode: true })
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("AUTO"), "auto banner visible")
  assert.ok(frame.includes("PLAN"), "plan banner visible")
})

test("renderFrame: multimodal hint on supported model with image paste shortcut", () => {
  const state = tuiState()
  const agent = tuiAgent()
  agent.provider.model = "kimi-k3"
  const { frame } = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [], platform: "linux" })
  assert.ok(frame.includes("paste"), "paste shortcut shown")
})

// ====================================================================
// clipboard.mjs — insertPastedText routing
// ====================================================================

test("insertPastedText: free-text question active → appends to answer, strips newlines, input untouched", async () => {
  const { insertPastedText } = await import("../src/tui/clipboard.mjs")
  const state = tuiState()
  state.question = { text: "Enter API key:", options: [], answer: "sk-", resolve: noop }
  insertPastedText(state, "abc123\r\n")
  assert.equal(state.question.answer, "sk-abc123")
  assert.equal(state.input.length, 0, "pasted text must not leak into main input box")
})

test("insertPastedText: options question active → ignored (no text field)", async () => {
  const { insertPastedText } = await import("../src/tui/clipboard.mjs")
  const state = tuiState()
  state.question = { text: "pick", options: ["a", "b"], selected: 0, resolve: noop }
  insertPastedText(state, "hello")
  assert.equal(state.input.length, 0, "pasted text discarded, not orphaned in input box")
})

test("insertPastedText: no question → inserts into main input at cursor, keeps newlines, tabs → 2 spaces", async () => {
  const { insertPastedText } = await import("../src/tui/clipboard.mjs")
  const state = tuiState()
  state.input = [..."ab"]
  state.cursor = 1
  insertPastedText(state, "X\r\nY\tZ")
  assert.equal(state.input.join(""), "aX\nY  Zb")
  assert.equal(state.cursor, 7)
})

// ====================================================================
// key-handler.mjs — createKeyHandler
// ====================================================================

function noop() {}
function keyCtx(state, agent = null) {
  return {
    agent: agent || tuiAgent(), state,
    render: noop, closePicker: noop, renderPickerLines: noop,
    handleSlash: noop, handleTab: noop,
    submit: async () => {}, pasteClipboardImage: async () => {},
    wizardChooseProvider: noop, wizardSubmitText: noop, cancelWizard: noop,
    wizardProviderItems: () => [], renderWizard: noop,
    pushLine: noop, cleanup: noop,
  }
}

test("keyHandler: input characters build up input buffer", () => {
  const state = tuiState()
  const handler = createKeyHandler(keyCtx(state))
  handler("h", { name: "h" })
  handler("e", { name: "e" })
  handler("l", { name: "l" })
  handler("l", { name: "l" })
  handler("o", { name: "o" })
  assert.equal(state.input.join(""), "hello")
})

test("keyHandler: backspace deletes character before cursor", () => {
  const state = tuiState({ input: [..."abc"], cursor: 3 })
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "backspace" })
  assert.equal(state.input.join(""), "ab")
  assert.equal(state.cursor, 2)
})

test("keyHandler: cursor movement left/right", () => {
  const state = tuiState({ input: [..."abc"], cursor: 3 })
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "left" })
  assert.equal(state.cursor, 2)
  handler("", { name: "left" })
  assert.equal(state.cursor, 1)
  handler("", { name: "right" })
  assert.equal(state.cursor, 2)
})

test("keyHandler: up/down cycle through input history (down past end clears input)", () => {
  const state = tuiState({ history: [[..."first"], [..."second"]], historyIndex: -1, input: [..."current"] })
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "up" })
  assert.equal(state.input.join(""), "second", "first up loads last history entry")
  handler("", { name: "up" })
  assert.equal(state.input.join(""), "first", "second up loads earlier entry")
  handler("", { name: "down" })
  assert.equal(state.input.join(""), "second", "first down goes forward in history")
  handler("", { name: "down" })
  assert.equal(state.input.join(""), "")
  assert.equal(state.historyIndex, -1)
})

test("keyHandler: permission y/n/a resolution", () => {
  const state = tuiState({
    permission: { name: "write", resolve: () => {} },
    permissionPreview: ["content preview"],
  })
  let approved = null
  state.permission.resolve = (v) => { approved = v }
  const handler = createKeyHandler(keyCtx(state))
  handler("y", { name: "y" })
  assert.equal(approved, true)
  assert.equal(state.permission, null)
})

test("keyHandler: permission 'a' sets AUTO and approves", () => {
  const agent = tuiAgent()
  const state = tuiState({
    permission: { name: "write", resolve: () => {} },
    permissionPreview: ["content preview"],
  })
  let approved = null
  state.permission.resolve = (v) => { approved = v }
  const handler = createKeyHandler(keyCtx(state, agent))
  handler("a", { name: "a" })
  assert.equal(approved, true)
  assert.equal(agent.autoApprove, true)
  assert.equal(state.permission, null)
})

test("keyHandler: question free-text submit resolves answer", () => {
  const state = tuiState({ question: { text: "What?", options: [], answer: "my answer", resolve: () => {} } })
  let resolved = null
  state.question.resolve = (v) => { resolved = v }
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "return" })
  assert.equal(resolved, "my answer")
  assert.equal(state.question, null)
})

test("keyHandler: question option selection via up/down/enter", () => {
  const state = tuiState({
    question: { text: "Pick", options: ["A", "B", "C"], selected: 0, resolve: () => {} },
  })
  let resolved = null
  state.question.resolve = (v) => { resolved = v }
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "down" })
  assert.equal(state.question.selected, 1)
  handler("", { name: "down" })
  assert.equal(state.question.selected, 2)
  handler("", { name: "return" })
  assert.equal(resolved, "C")
  assert.equal(state.question, null)
})

test("keyHandler: ctrl+c during processing aborts controller", () => {
  let aborted = false
  const controller = { abort: () => { aborted = true } }
  const state = tuiState({ processing: true, controller })
  const handler = createKeyHandler(keyCtx(state))
  handler("", { name: "c", ctrl: true })
  assert.ok(aborted)
})

test("keyHandler: tab during processing is blocked", () => {
  let tabCalled = false
  const state = tuiState({ processing: true, input: [..."/hel"] })
  const handler = createKeyHandler({
    ...keyCtx(state), handleTab: () => { tabCalled = true },
  })
  handler("", { name: "tab" })
  assert.equal(tabCalled, false, "tab blocked during processing")
})

test("keyHandler: printable during processing adds to input (queued messages)", () => {
  const state = tuiState({ processing: true })
  const handler = createKeyHandler(keyCtx(state))
  handler("x", { name: "x" })
  assert.equal(state.input.join(""), "x")
})

test("keyHandler: escape in picker closes it", () => {
  let closed = false
  const state = tuiState({
    picker: { entries: [{ type: "item", value: "x", label: "x" }], index: 0, lines: [], scroll: 0 },
  })
  const handler = createKeyHandler({
    ...keyCtx(state), closePicker: () => { closed = true },
  })
  handler("", { name: "escape" })
  assert.ok(closed)
})
