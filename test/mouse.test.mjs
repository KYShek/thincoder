/**
 * mouse.test.mjs — SGR mouse click parsing + hit-testing + line actions
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { parseMouseClicks, convGlobalIndex, handleMouseClick } from "../src/tui/mouse.mjs"

/** Minimal TUI state satisfying computeLayout + buildConvLines accessors. */
function mockState(extra = {}) {
  return {
    search: null, interruptPrompt: null, input: [], cursor: 0, question: null,
    picker: null, wizard: null, tasks: [], processing: false, subTasks: {},
    outputPanels: {}, permission: null, permissionPreview: [], queue: [],
    lines: [], reasoning: "", _advisorThink: null, advisorStreaming: "",
    streaming: "", foldEnabled: true, expandedBlocks: null, scroll: 0,
    ...extra,
  }
}

describe("parseMouseClicks — SGR \x1b[<0;col;rowM extraction", () => {
  it("extracts a left-click press", () => {
    assert.deepEqual(parseMouseClicks("\x1b[<0;10;5M"), [{ col: 10, row: 5 }])
  })

  it("ignores releases (lowercase m) and wheel (button 64/65)", () => {
    assert.deepEqual(parseMouseClicks("\x1b[<0;3;3m\x1b[<64;3;3M\x1b[<65;3;3M"), [])
  })

  it("extracts multiple clicks mixed with other input", () => {
    const text = "abc\x1b[<0;1;2M\x1b[<0;20;30Mxyz"
    assert.deepEqual(parseMouseClicks(text), [{ col: 1, row: 2 }, { col: 20, row: 30 }])
  })

  it("handles incomplete tail (no false match on partial)", () => {
    assert.deepEqual(parseMouseClicks("\x1b[<0;1;"), [])
  })
})

describe("convGlobalIndex — screen row → conversation line mapping", () => {
  it("maps the first visible row at scroll 0", () => {
    const map = convGlobalIndex(10, 5, 0)
    assert.equal(map(0), 5) // end=10, visible=slice(5,10) → local 0 = global 5
    assert.equal(map(4), 9)
    assert.equal(map(5), null) // padding rows
  })

  it("content shorter than panel starts at row 0", () => {
    const map = convGlobalIndex(3, 19, 0)
    assert.equal(map(0), 0)
    assert.equal(map(2), 2)
    assert.equal(map(3), null) // padding
  })

  it("follows scroll offset", () => {
    const map = convGlobalIndex(10, 5, 3)
    assert.equal(map(0), 2)
    assert.equal(map(4), 6)
  })

  it("clamps scroll beyond max", () => {
    const map = convGlobalIndex(10, 5, 99)
    assert.equal(map(0), 0)
  })
})

describe("handleMouseClick — picker selection", () => {
  it("clicking an option row resolves the picker with that item", () => {
    const state = mockState()
    let popped = null
    state.picker = {
      title: "Test", entries: [{ type: "item", text: "A" }, { type: "item", text: "B" }, { type: "item", text: "C" }],
      lines: [
        { text: " ❯ Test ", _row: undefined },                       // title (index 0)
        { text: "   A", _row: 0 },
        { text: "   B", _row: 1 },
        { text: "   C", _row: 2 },
      ],
      filteredItems: [{ type: "item", text: "A" }, { type: "item", text: "B" }, { type: "item", text: "C" }],
      index: 0, scroll: 0, selectedLine: 1, filter: "", resolve: () => {},
    }
    const ctx = { state, render: () => {}, showPicker: async () => null, popPicker: (v) => { popped = v } }
    // picker panel: computeLayout puts it below conversation; force a tiny layout by stubbing process.stdout
    // → use a small terminal so conversation=1 row and picker sits right after it.
    const orig = { cols: process.stdout.columns, rows: process.stdout.rows }
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true })
    try {
      // Layout (80x24): header=1, conversation=14, picker.y=15(0-based) → title row=16,
      // first option "A" = 1-based row 18 (title at y+0, option at y+1)
      const consumed = handleMouseClick(ctx, 10, 18)
      assert.equal(consumed, true)
      assert.equal(popped?.text, "A")
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: orig.cols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: orig.rows, configurable: true })
    }
  })
})

describe("handleMouseClick — conversation line actions", () => {
  it("clicking a folded-block hint expands it", async () => {
    const { C } = await import("../src/tui/ansi.mjs")
    const state = mockState({
      lines: [
        { text: "x", color: "" },
        { text: "y", color: "" },
      ],
    })
    const ctx = { state, render: () => { rendered = true }, showPicker: async () => null, popPicker: () => {} }
    let rendered = false
    // Directly exercise the fold branch by pre-building convLines with a fold toggle:
    // buildConvLines folds ≥8 consecutive dim lines; feed 9 dim lines.
    state.lines = Array.from({ length: 9 }, (_, i) => ({ text: `dim${i}`, color: C.dim }))
    const orig = { cols: process.stdout.columns, rows: process.stdout.rows }
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true })
    try {
      // Layout (80x24, no overlays): conversation starts at row 2 (1-based).
      // 9 dim lines fold to [dim0, dim1, "… 7 more — Enter to expand"] = 3 conv lines;
      // the fold hint is the 3rd conv line = 1-based row 4.
      const consumed = handleMouseClick(ctx, 10, 4)
      assert.equal(consumed, true)
      assert.ok(state.expandedBlocks?.size > 0, "expandedBlocks populated")
      assert.equal(rendered, true)
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: orig.cols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: orig.rows, configurable: true })
    }
  })

  it("clicking a message line opens the action menu", async () => {
    const state = mockState({
      lines: [{ text: "hello world", color: "" }],
    })
    let menu = null
    const ctx = {
      state,
      render: () => {},
      showPicker: async (title, entries) => { menu = { title, entries }; return null },
      popPicker: () => {},
    }
    const orig = { cols: process.stdout.columns, rows: process.stdout.rows }
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true })
    try {
      const consumed = handleMouseClick(ctx, 10, 2)
      assert.equal(consumed, true)
      await new Promise((r) => setTimeout(r, 10)) // let the async menu open
      assert.equal(menu?.title, "Line actions")
      assert.ok(menu.entries.some((e) => e.action === "copy"))
      assert.ok(menu.entries.some((e) => e.action === "edit"))
    } finally {

describe("long-message folding (render-conversation)", () => {
  it("a single long DIM line folds to [first, hint, last] and expands via click key", async () => {
    const { C } = await import("../src/tui/ansi.mjs")
    const { buildConvLines, convCacheKey } = await import("../src/tui/render-conversation.mjs")
    const state = {
      lines: [{ text: "L1\n" + "line2\n".repeat(15) + "last", color: C.dim }],
      streaming: "", reasoning: "", _advisorThink: null, advisorStreaming: "",
      foldEnabled: true, expandedBlocks: new Set(), scroll: 0, search: null,
    }
    const cols = 80
    const folded = buildConvLines(state, cols)
    // 12-line threshold: full block = 1 + 15 + 1 = 17 lines → folded to 3
    assert.equal(folded.length, 3, "long dim message folded to [first, hint, last]")
    assert.equal(folded[0].text, "L1")
    assert.match(folded[1].text, /more lines — click to expand/)
    assert.equal(folded[2].text, "last")
    const toggleKey = folded[1]._foldToggle
    assert.ok(toggleKey?.startsWith("long-"), "fold key is long-<srcIndex>")

    // Expand: add the key → full block renders; cache key must change
    const keyBefore = convCacheKey(state)
    state.expandedBlocks.add(toggleKey)
    const keyAfter = convCacheKey(state)
    assert.notEqual(keyBefore, keyAfter, "expandedBlocks participates in the cache key")
    const expanded = buildConvLines(state, cols)
    assert.equal(expanded.length, 17, "expanded to full content")
  })

  it("MAIN OUTPUT (C.text) and THINKING (C.reason) are never folded — readability regression", async () => {
    const { C } = await import("../src/tui/ansi.mjs")
    const { buildConvLines } = await import("../src/tui/render-conversation.mjs")
    const longText = "line0\n" + "content\n".repeat(20) + "end"
    for (const color of [C.text, C.reason]) {
      const state = {
        lines: [{ text: longText, color }],
        streaming: "", reasoning: "", _advisorThink: null, advisorStreaming: "",
        foldEnabled: true, expandedBlocks: new Set(), scroll: 0, search: null,
      }
      const out = buildConvLines(state, 80)
      assert.equal(out.length, 22, `${JSON.stringify(color)} main output must render in full`)
      assert.ok(!out.some((l) => l._foldToggle), "no fold hint for main output")
    }
  })

  it("short lines are not folded", async () => {
    const { C } = await import("../src/tui/ansi.mjs")
    const { buildConvLines } = await import("../src/tui/render-conversation.mjs")
    const state = {
      lines: [{ text: "short", color: C.dim }, { text: "another", color: C.dim }],
      streaming: "", reasoning: "", _advisorThink: null, advisorStreaming: "",
      foldEnabled: true, expandedBlocks: new Set(), scroll: 0, search: null,
    }
    assert.equal(buildConvLines(state, 80).length, 2)
  })
})

      Object.defineProperty(process.stdout, "columns", { value: orig.cols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: orig.rows, configurable: true })
    }
  })

  it("clicks outside panels are ignored", () => {
    const state = mockState()
    const ctx = { state, render: () => {}, showPicker: async () => null, popPicker: () => {} }
    const orig = { cols: process.stdout.columns, rows: process.stdout.rows }
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
    Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true })
    try {
      assert.equal(handleMouseClick(ctx, 5, 24), false) // status row → not consumed
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: orig.cols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: orig.rows, configurable: true })
    }
  })
})
