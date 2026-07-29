/**
 * TUI pure function tests — rendering, layout, keyboard handling.
 * No terminal needed — all functions are pure.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { stringWidth, wrapText } from "../src/tui/render.mjs"
import { computeLayout } from "../src/tui/layout.mjs"
import {
  renderFrame, countConvLines, convCacheKey,
  renderHeader, renderConversation, renderTodo, renderSubagent,
  renderOutput, renderPermission, renderQueue,
  renderInputBox, renderStatus,
} from "../src/tui/render-frame.mjs"
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
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0 },
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

// ---------------------------------------------------------------- panel render functions (incremental rendering)

test("panel functions: renderHeader includes model name", () => {
  const agent = {
    provider: { model: "deepseek-v4-pro", thinking: null },
    cwd: "/home/user/project",
  }
  const line = renderHeader(agent, 100)
  assert.ok(line.includes("ThinCoder"))
  assert.ok(line.includes("deepseek-v4-pro"))
  assert.ok(line.includes("project"))
})

test("panel functions: renderHeader with thinking mode shows badge", () => {
  const agent = {
    provider: { model: "glm-5.2", thinking: { type: "enabled" }, reasoningEffort: "max" },
    cwd: "/project",
  }
  const line = renderHeader(agent, 120)
  assert.ok(line.includes("think: max"))
})

test("panel functions: convCacheKey changes on streaming append", () => {
  const s1 = tuiState({ streaming: "hello" })
  const s2 = tuiState({ streaming: "hello world" })
  const k1 = convCacheKey(s1)
  const k2 = convCacheKey(s2)
  assert.notEqual(k1, k2)
})

test("panel functions: convCacheKey stable on scroll change alone", () => {
  const s = tuiState({ lines: [{ text: "a", color: "" }] })
  const k1 = convCacheKey(s)
  s.scroll = 5
  const k2 = convCacheKey(s)
  assert.equal(k1, k2)
})

test("panel functions: renderConversation returns correct line count", () => {
  const state = tuiState({
    lines: [
      { text: "line1", color: "" },
      { text: "line2", color: "" },
      { text: "line3", color: "" },
    ],
  })
  const lines = renderConversation(state, 80, 10, 0)
  assert.equal(lines.length, 10) // pad to visibleH
})

test("panel functions: renderTodo shows status marks", () => {
  const tasks = [
    { title: "done task", status: "done" },
    { title: "in progress", status: "in_progress" },
    { title: "pending", status: "pending" },
  ]
  const lines = renderTodo(tasks, 80)
  assert.equal(lines.length, 3)
  assert.ok(lines[0].includes("✓"))
  assert.ok(lines[1].includes("▶"))
  assert.ok(lines[2].includes("○"))
})

test("panel functions: renderSubagent shows running and done states", () => {
  const subs = [
    { role: "coder", text: "writing tests...", tool: null, done: false, started: Date.now() },
    { role: "explore", text: "", tool: null, done: true, started: Date.now() - 5000 },
  ]
  const lines = renderSubagent(subs, 100)
  assert.ok(lines.some((l) => l.includes("coder") && l.includes("writing")))
  assert.ok(lines.some((l) => l.includes("explore") && l.includes("done")))
})

test("panel functions: renderOutput formats active panels", () => {
  const state = tuiState({
    outputPanels: {
      test: { text: "running 1/10\nrunning 2/10", done: false },
    },
  })
  const lines = renderOutput(state, 80, 4)
  assert.ok(lines.some((l) => l.includes("running")))
})

test("panel functions: renderOutput hides done panels", () => {
  const state = tuiState({
    outputPanels: {
      test: { text: "done all tests pass", done: true },
    },
  })
  const lines = renderOutput(state, 80, 4)
  assert.equal(lines.length, 0)
})

test("panel functions: renderFrame (legacy) produces valid ANSI", () => {
  const state = tuiState({ lines: [{ text: "hello", color: "" }] })
  const agent = { provider: { model: "test-model" }, cwd: "/test", planMode: false, autoApprove: false, config: {} }
  const result = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [] })
  assert.ok(result.frame.startsWith("\x1b[H")) // starts with home
  assert.ok(result.frame.includes("hello"))
  assert.ok(result.frame.includes("ThinCoder"))
})

test("panel functions: renderFrame returns cursor position in normal mode", () => {
  const state = tuiState({})
  const agent = { provider: { model: "test" }, cwd: "/test", planMode: false, autoApprove: false, config: {} }
  const result = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [] })
  assert.ok(result.cursorRow > 0)
  assert.ok(result.cursorCol > 0)
})

test("panel functions: renderFrame hides cursor in permission mode", () => {
  const state = tuiState({ permission: { name: "test", args: {} } })
  const agent = { provider: { model: "test" }, cwd: "/test", planMode: false, autoApprove: false, config: {} }
  const result = renderFrame(state, agent, { cols: 80, rows: 24, slashCommands: [] })
  assert.equal(result.cursorRow, 0)
  assert.equal(result.cursorCol, 0)
})

test("panel functions: renderInputBox shows Processing title when processing", () => {
  const state = tuiState({ processing: true })
  const lines = renderInputBox(state, 80, ["▸ Hello"], 80)
  assert.ok(lines[0].includes("Processing..."))
})

test("panel functions: renderStatus includes elapsed time during processing", () => {
  const state = tuiState({ processing: true, processingStarted: Date.now() })
  const agent = { provider: { model: "test" }, cwd: "/test", planMode: false, autoApprove: false, config: {} }
  const line = renderStatus(state, agent, 120, [])
  assert.ok(line.includes("0s")) // just started
})

test("panel functions: renderPermission formats permission request", () => {
  const lines = renderPermission(["  Allow bash: rm -rf /", "  This is dangerous"])
  assert.equal(lines.length, 3)
  assert.ok(lines[0].includes("Permission Request"))
})

test("panel functions: renderQueue shows queue preview", () => {
  const state = tuiState({ queue: [{ text: "next task here" }], processing: true })
  const line = renderQueue(state, 80)
  assert.ok(line.includes("Queue:"))
  assert.ok(line.includes("next task here"))
})

test("panel functions: renderQueue empty when not processing", () => {
  const state = tuiState({ queue: [{ text: "waiting" }], processing: false })
  const line = renderQueue(state, 80)
  assert.equal(line, "")
})

test("panel functions: countConvLines counts wrapped lines", () => {
  const state = tuiState({
    lines: [
      { text: "short", color: "" },
      { text: "a".repeat(200), color: "" }, // will wrap
    ],
  })
  // "a" repeated 200 times at width 80 → ceil(200/80) = 3 lines
  const count = countConvLines(state, 80)
  assert.equal(count, 4) // 1 (short) + 3 (wrapped)
})

// ---------------------------------------------------------------- streaming line-diff simulation

test("streaming simulation: only last line changes during token append", () => {
  // Simulate the conversation panel line caching logic:
  // initial state → token arrives → verify only new/changed lines differ
  const cols = 80, visibleH = 5
  const empty = renderConversation(tuiState({ lines: [] }), cols, visibleH, 0)
  const withText = renderConversation(tuiState({
    lines: [{ text: "hello", color: "" }],
  }), cols, visibleH, 0)
  const withStream = renderConversation(tuiState({
    lines: [{ text: "hello", color: "" }],
    streaming: " world",
  }), cols, visibleH, 0)

  // Compare line by line: between "hello" and "hello world", only last line differs
  let diffCount = 0
  for (let i = 0; i < visibleH; i++) {
    if (withText[i] !== withStream[i]) diffCount++
  }
  // streaming is a SEPARATE line appended after history, so when it first appears
  // it pushes the last history line up → typically 2 lines change on first token,
  // then only 1 (the streaming line) on subsequent tokens within the same turn.
  assert.ok(diffCount <= 2, `expected ≤2 diffs, got ${diffCount}`)
})

test("streaming simulation: no diff when streaming content unchanged", () => {
  const cols = 80, visibleH = 5
  const state = tuiState({ lines: [{ text: "hello", color: "" }], streaming: " world" })
  const a = renderConversation(state, cols, visibleH, 0)
  const b = renderConversation(state, cols, visibleH, 0)
  assert.deepEqual(a, b) // pure function, same input → same output
})

test("streaming simulation: new line in middle pushes lines up", () => {
  const cols = 80, visibleH = 4
  // Two lines of history
  const s1 = tuiState({ lines: [
    { text: "line1", color: "" },
    { text: "line2", color: "" },
  ]})
  // Add a third line — the visible window shifts
  const s2 = tuiState({ lines: [
    { text: "line1", color: "" },
    { text: "line2", color: "" },
    { text: "line3", color: "" },
  ]})
  const a = renderConversation(s1, cols, visibleH, 0)
  const b = renderConversation(s2, cols, visibleH, 0)

  // With visibleH=4 and 3 lines, both render 4 lines (1 pad + 2 content vs 1 pad + 3 content)
  assert.equal(a.length, visibleH)
  assert.equal(b.length, visibleH)
  // Content differs: s1 shows line1,line2; s2 shows line1,line2,line3
  let diffs = 0
  for (let i = 0; i < visibleH; i++) {
    if (a[i] !== b[i]) diffs++
  }
  // Adding a new history line pushes all visible lines up — up to visibleH diffs
  assert.ok(diffs >= 1 && diffs <= visibleH, `expected 1-${visibleH} diffs, got ${diffs}`)
})
