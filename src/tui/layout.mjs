/**
 * layout.mjs — TUI layout engine (pure function)
 * Computes position and height of each panel from state + terminal dimensions.
 * Does not modify state — side effects are performed by the caller before rendering.
 *
 *   header → conversation → subagent → output → todo → picker → permission → queue → input → status
 *   header → conversation → todo → subagent → output → picker → permission → queue → input → status
 * Fixed panels deducted first, conditional panels allocated by priority, remaining space to conversation.
 */
import { layoutInput, wrapText } from "./render.mjs"

const MAX_INPUT_LINES = 5
const MAX_TASK_LINES = 5
export const MAX_SUB_LINES = 4
const QWIN = 5

/**
 * Computes layout. Returns panel coordinates + precomputed content (height-affecting parts).
 * Pure function: does not modify state.
 */
export function computeLayout(state, { cols, rows }) {
  const W = Math.max(20, cols - 1)

  // --- input box ---
  const inputBuf = state.interruptPrompt ? [...state.interruptPrompt.text] : state.input
  const inputCursor = state.interruptPrompt ? inputBuf.length : state.cursor
  const inputLayout = layoutInput(inputBuf, inputCursor, W - 4)
  let inputOffset = 0
  if (inputLayout.lines.length > MAX_INPUT_LINES) {
    inputOffset = Math.min(inputLayout.cursorLine, inputLayout.lines.length - MAX_INPUT_LINES)
  }
  const inputLines = inputLayout.lines.slice(inputOffset, inputOffset + MAX_INPUT_LINES)
  let boxLines = inputLines
  if (state.question) {
    const q = state.question
    if (q.options.length > 0) {
      const sel = q.selected ?? 0
      const start = Math.max(0, Math.min(sel - 2, q.options.length - QWIN))
      boxLines = q.options.slice(start, start + QWIN).map((opt, i) => (start + i === sel ? "▸ " : "  ") + opt)
    } else {
      boxLines = ["▸ " + (q.answer ?? "")]
    }
  }
  const inputBoxH = boxLines.length + 2

  // --- fixed panels ---
  const headerH = 1
  const statusH = 1

  // --- conditional panels ---
  const overlay = state.picker ?? state.wizard
  const pickerH = overlay ? Math.min(overlay.lines.length + 1, Math.max(6, rows - 12)) : 0

  // Todo
  let visibleTasks = []
  if (state.tasks.length <= MAX_TASK_LINES) {
    visibleTasks = state.tasks
  } else {
    const inProgress = state.tasks.filter((t) => t.status === "in_progress")
    const pending = state.tasks.filter((t) => t.status === "pending")
    const done = state.tasks.filter((t) => t.status === "done")
    visibleTasks = [...inProgress, ...pending, ...done].slice(0, MAX_TASK_LINES)
  }
  const taskPanelH = visibleTasks.length

  // Subagent (only visible during processing; height matches what's actually rendered)
  const allSubs = state.processing ? Object.values(state.subTasks) : []
  const subPanelH = allSubs.length > 0
    ? Math.min(allSubs.length, MAX_SUB_LINES) + (allSubs.length > MAX_SUB_LINES ? 1 : 0)
    : 0

  // Tool output panels: max 8 lines per panel, capped at reasonable total
  const panels = Object.values(state.outputPanels).filter((p) => !p.done)
  const outputPanelsH = panels.length > 0 ? Math.min(panels.length * 8, rows - 10) : 0

  // Permission preview (height depends on wrapped content)
  let permPreviewLines = []
  let permPreviewH = 0
  if (state.permission) {
    const maxLines = Math.max(1, rows - 8)
    outer: for (const l of state.permissionPreview) {
      for (const wrapped of wrapText(`  ${l}`, W - 1)) {
        if (permPreviewLines.length >= maxLines) break outer
        permPreviewLines.push(wrapped)
      }
    }
    permPreviewH = 1 + permPreviewLines.length // 1 for header line
  }

  // Queue preview (1 line when queue has items and processing)
  const queueH = state.queue.length > 0 && state.processing ? 1 : 0

  // --- elastic panel: conversation takes remaining space ---
  const fixedH = headerH + inputBoxH + statusH + pickerH + taskPanelH + subPanelH + outputPanelsH + permPreviewH + queueH
  const convH = Math.max(1, rows - fixedH)

  // --- Y coordinates (0-indexed, +1 when used with ANSI) ---
  let y = 0
  const header = { y, h: headerH }; y += headerH
  const conversation = { y, h: convH }; y += convH
  const subagent = subPanelH > 0 ? { y, h: subPanelH } : null; y += subPanelH
  const output = outputPanelsH > 0 ? { y, h: outputPanelsH } : null; y += outputPanelsH
  const todo = taskPanelH > 0 ? { y, h: taskPanelH } : null; y += taskPanelH
  const picker = pickerH > 0 ? { y, h: pickerH } : null; y += pickerH
  const permission = permPreviewH > 0 ? { y, h: permPreviewH } : null; y += permPreviewH
  const queue = queueH > 0 ? { y, h: queueH } : null; y += queueH
  const inputBox = { y, h: inputBoxH }; y += inputBoxH
  const status = { y, h: statusH }

  return {
    W, cols, rows,
    panels: { header, conversation, picker, todo, subagent, output, permission, queue, inputBox, status },
    // precomputed content (affects height, reused during render)
    inputLayout,
    inputOffset,
    boxLines,
    visibleTasks,
    allSubs,
    permPreviewLines,
    overlay,
  }
}
