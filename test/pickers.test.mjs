/**
 * pickers.mjs tests — picker 栈 / showPicker 互斥 / 过滤 / defaultIndex / 异步更新选中恢复。
 * Mock ctx 与 tui.test.mjs / slash-commands.test.mjs 同风格。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { createPickers } from "../src/tui/pickers.mjs"

/** Minimal ctx mock: picker 只需要 state/render/ansi/C 等少数字段。 */
function pickersCtx(overrides = {}) {
  const state = {}
  const lines = []
  const ctx = {
    agent: { providers: [], activeProvider: "", provider: {}, config: {} },
    state,
    render: () => {},
    ansi: { bold: "" },
    C: { tool: "", text: "", dim: "", error: "" },
    pushLine: (t) => lines.push(t),
    pushLabel: (t) => lines.push(t),
    persistRaw: async () => {},
    askQuestion: async () => "",
    maskKey: () => "***",
    ...overrides,
  }
  return { ctx, state, lines }
}

const ENTRIES = [
  { type: "header", text: "Group" },
  { type: "item", text: "alpha" },
  { type: "item", text: "Beta" },
  { type: "item", text: "gamma" },
]

// ====================================================================
// showPicker / popPicker / closePicker 栈语义
// ====================================================================

test("showPicker: 入栈并暴露 filteredItems，Enter(popPicker) resolve 选中项", async () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, popPicker } = createPickers(ctx)
  const p = showPicker("T", ENTRIES)
  assert.equal(state.picker.title, "T")
  assert.equal(state.pickerStack.length, 1)
  assert.deepEqual(state.picker.filteredItems.map((e) => e.text), ["alpha", "Beta", "gamma"])
  popPicker(state.picker.filteredItems[1])
  assert.equal((await p).text, "Beta")
  assert.equal(state.picker, null)
  assert.equal(state.pickerStack.length, 0)
})

test("showPicker 互斥: 栈非空时再次调用，前一个 Promise resolve(null)", async () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, closePicker } = createPickers(ctx)
  const p1 = showPicker("first", ENTRIES)
  const p2 = showPicker("second", ENTRIES)
  assert.equal(await p1, null, "被顶替的 picker resolve(null)，无 Promise 悬挂")
  assert.equal(state.picker.title, "second")
  assert.equal(state.pickerStack.length, 1)
  closePicker()
  assert.equal(await p2, null)
})

test("closePicker: 清空栈，所有挂起者 resolve(null)", async () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, closePicker } = createPickers(ctx)
  const p1 = showPicker("A", ENTRIES)
  const p2 = showPicker("B", ENTRIES) // p1 已被互斥 resolve(null)
  closePicker()
  assert.equal(await p1, null)
  assert.equal(await p2, null)
  assert.equal(state.picker, null)
  assert.equal(state.pickerStack.length, 0)
})

test("popPicker: resolve 栈顶并恢复下层（两层嵌套）", async () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, popPicker } = createPickers(ctx)
  const outer = showPicker("outer", ENTRIES)
  const outerPicker = state.picker
  // 手工压入第二层（showPicker 有互斥，嵌套层只能由内部流程直接压栈）
  let innerResolve
  const inner = new Promise((r) => { innerResolve = r })
  state.pickerStack.push({ title: "inner", entries: ENTRIES, lines: [], index: 0, scroll: 0, selectedLine: 0, filter: "", resolve: innerResolve })
  state.picker = state.pickerStack.at(-1)
  assert.equal(state.picker.title, "inner")

  popPicker(ENTRIES[3])
  assert.equal((await inner).text, "gamma")
  assert.equal(state.picker, outerPicker, "pop 后 state.picker 恢复指向下层")

  popPicker(null)
  assert.equal(await outer, null)
  assert.equal(state.picker, null)
})

// ====================================================================
// defaultIndex clamp
// ====================================================================

test("showPicker: defaultIndex clamp 到 item 范围", async () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, closePicker } = createPickers(ctx)
  showPicker("A", ENTRIES, { defaultIndex: 99 })
  assert.equal(state.picker.index, 2)
  closePicker()
  showPicker("B", ENTRIES, { defaultIndex: -5 })
  assert.equal(state.picker.index, 0)
  closePicker()
  showPicker("C", ENTRIES, { defaultIndex: 1 })
  assert.equal(state.picker.index, 1)
  closePicker()
})

// ====================================================================
// rebuildLines 过滤
// ====================================================================

test("rebuildLines: 子串大小写不敏感过滤，header 恒显示，filter 后 index clamp", () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, renderPickerLines } = createPickers(ctx)
  showPicker("T", ENTRIES)
  const p = state.picker
  p.index = 2
  p.filter = "BET" // 大写 filter 匹配 "Beta"
  renderPickerLines()
  assert.deepEqual(p.filteredItems.map((e) => e.text), ["Beta"])
  assert.equal(p.index, 0, "index clamp 到过滤后范围")
  assert.ok(p.lines.some((l) => l.text.includes("Group")), "header 恒显示")
  assert.ok(!p.lines.some((l) => l.text.includes("alpha")))
})

test("rebuildLines: 无匹配显示 (no match)", () => {
  const { ctx, state } = pickersCtx()
  const { showPicker, renderPickerLines } = createPickers(ctx)
  showPicker("T", ENTRIES)
  state.picker.filter = "zzz"
  renderPickerLines()
  assert.equal(state.picker.filteredItems.length, 0)
  assert.ok(state.picker.lines.some((l) => l.text.includes("(no match)")))
})

// ====================================================================
// /model 异步更新：按 entry 标识恢复选中
// ====================================================================

test("openModelPicker: listModels 异步 splice 后按 provider/model 标识恢复选中项", async () => {
  // 本地 HTTP server 模拟 GET /models（端口 0 随机分配）
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const baseURL = `http://127.0.0.1:${server.address().port}`

  const agent = {
    providers: [
      { name: "p1", baseURL, model: "m1", apiKey: "k" },
      { name: "active", baseURL, model: "m1", apiKey: "k" },
    ],
    activeProvider: "active",
    provider: { model: "m1" },
    config: {},
  }
  const { ctx, state } = pickersCtx({ agent })
  const { openModelPicker, popPicker } = createPickers(ctx)

  const flow = openModelPicker() // 不 await：它停在 showPicker 上等用户选择
  try {
    // 等异步 listModels 完成（每个 provider 分组下会多出 m2/m3，items 从 5 → 9）
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if ((state.picker?.filteredItems ?? []).length > 5) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const items = state.picker.filteredItems
    assert.ok(items.length > 5, "模型列表已异步合并")

    // 选中 "active/m1"（当前模型），再触发一次异步更新场景无法直接重放，
    // 但首次 splice 完成后选中应仍指向打开时的当前模型项而不是错位到别的 entry
    const sel = items[state.picker.index]
    assert.equal(sel.action, "switch")
    assert.equal(sel.provider, "active")
    assert.equal(sel.model, "m1")

    popPicker(null) // Esc 退出菜单循环
    await flow
  } finally {
    server.close()
  }
})
