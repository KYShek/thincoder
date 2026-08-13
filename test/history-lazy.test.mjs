/**
 * history-lazy.test.mjs — lazy history restore (CLI parity with VS Code lazy loading).
 * Locks historyToLines (the source-line materializer) and the page-slice math so
 * a huge restored session no longer rebuilds eagerly.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { historyToLines, INITIAL_HISTORY_MESSAGES, HISTORY_PAGE_MESSAGES } from "../src/tui/startup.mjs"

test("historyToLines materializes user/assistant/tool lines with summaries", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", tool_calls: [{ id: "t1", function: { name: "bash" } }] },
    { role: "tool", tool_call_id: "t1", content: "ls\napp.js" },
  ]
  const lines = historyToLines(history, 0, 3)
  const texts = lines.map((l) => l.text)
  assert.ok(texts.includes("❯ You:"), "user label present")
  assert.ok(texts.includes("hi"), "user content present")
  assert.ok(texts.includes("❯ ThinCoder:"), "assistant label present")
  assert.ok(texts.includes("hello"), "assistant content present")
  assert.ok(texts.some((t) => t.includes("[tool] bash")), "tool call shown")
  assert.ok(texts.some((t) => t.includes("ls")), "tool result first-line summary shown (lookahead)")
})

test("historyToLines skips system-reminder user messages", () => {
  const history = [
    { role: "user", content: "[System reminder: working directory snapshot: …]" },
    { role: "user", content: "real question" },
  ]
  const lines = historyToLines(history, 0, 2)
  assert.ok(!lines.some((l) => l.text.includes("System reminder")), "reminder omitted")
  assert.ok(lines.some((l) => l.text === "real question"), "real user message kept")
})

test("historyToLines slices a page and lookahead works across the page edge", () => {
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: "A", tool_calls: [{ id: "t1", function: { name: "read" } }] },
    { role: "tool", tool_call_id: "t1", content: "file content line" },
    { role: "user", content: "second" },
  ]
  // Load only [0,2) — the assistant's tool result lives at index 2 (next page).
  const lines = historyToLines(history, 0, 2)
  const toolLine = lines.find((l) => l.text.includes("[tool] read"))
  assert.ok(toolLine, "tool call line present")
  assert.ok(toolLine.text.includes("file content line"), "summary resolved from the NEXT page (full-array lookahead)")
})

test("page constants align with VS Code parity (initial window > page size)", () => {
  assert.ok(INITIAL_HISTORY_MESSAGES > HISTORY_PAGE_MESSAGES)
  assert.equal(HISTORY_PAGE_MESSAGES, 50) // VS Code HISTORY_PAGE_SIZE parity
})
