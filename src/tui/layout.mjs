/**
 * layout.mjs — TUI 布局引擎（纯函数）
 * 从 state + 终端尺寸计算每个面板的位置和高度。
 * 不修改 state——副作用由调用方在渲染前执行。
 *
 * 面板布局（自上而下）：
 *   header → conversation → picker → todo → subagent → permission → queue → input → status
 * 固定面板先扣除，条件面板按优先级分配，剩余空间全给 conversation。
 */
import { layoutInput, wrapText } from "./render.mjs"

const MAX_INPUT_LINES = 5
const MAX_TASK_LINES = 5
export const MAX_SUB_LINES = 4
const QWIN = 5

/**
 * 计算布局。返回面板坐标 + 预计算的内容（影响高度的部分）。
 * 纯函数：不修改 state。
 */
export function computeLayout(state, { cols, rows }) {
  const W = Math.max(20, cols - 1)

  // --- 输入框 ---
  const inputLayout = layoutInput(state.input, state.cursor, W - 4)
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

  // --- 固定面板 ---
  const headerH = 1
  const statusH = 1

  // --- 条件面板 ---
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

  // --- 弹性面板：conversation 占剩余空间 ---
  const fixedH = headerH + inputBoxH + statusH + pickerH + taskPanelH + subPanelH + outputPanelsH + permPreviewH + queueH
  const convH = Math.max(1, rows - fixedH)

  // --- Y 坐标（0-indexed，ANSI 用时 +1）---
  let y = 0
  const header = { y, h: headerH }; y += headerH
  const conversation = { y, h: convH }; y += convH
  const picker = pickerH > 0 ? { y, h: pickerH } : null; y += pickerH
  const todo = taskPanelH > 0 ? { y, h: taskPanelH } : null; y += taskPanelH
  const subagent = subPanelH > 0 ? { y, h: subPanelH } : null; y += subPanelH
  const output = outputPanelsH > 0 ? { y, h: outputPanelsH } : null; y += outputPanelsH
  const permission = permPreviewH > 0 ? { y, h: permPreviewH } : null; y += permPreviewH
  const queue = queueH > 0 ? { y, h: queueH } : null; y += queueH
  const inputBox = { y, h: inputBoxH }; y += inputBoxH
  const status = { y, h: statusH }

  return {
    W, cols, rows,
    panels: { header, conversation, picker, todo, subagent, output, permission, queue, inputBox, status },
    // 预计算内容（影响高度，渲染时复用）
    inputLayout,
    inputOffset,
    boxLines,
    visibleTasks,
    allSubs,
    permPreviewLines,
    overlay,
  }
}
