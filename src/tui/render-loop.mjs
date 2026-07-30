/**
 * render-loop.mjs — frame scheduler + incremental panel rendering
 * Extracted from src/tui/index.mjs to keep the TUI entry point under 500 lines.
 */
import { computeLayout } from "./layout.mjs"
import {
  renderFrame, countConvLines, convCacheKey,
  renderHeader, renderConversation, renderTodo, renderSubagent,
  renderOutput, renderPermission, renderQueue, renderPicker,
  renderInputBox, renderStatus,
} from "./render-frame.mjs"
import { estimateTokens } from "../context.mjs"
import { ansi, C } from "./ansi.mjs"

const MIN_RENDER_INTERVAL_MS = 16

/**
 * Create the render loop closure. Returns { render, scheduleRender }.
 * 
 * @param {object} state  — TUI state
 * @param {object} agent  — agent instance
 * @param {object} ctx    — mutable context: { startupDims, SLASH_COMMANDS, showUpdateNotice }
 * @param {Function} pushLine — for error logging
 */
export function createRenderLoop(state, agent, ctx, pushLine) {
  const { startupDims, SLASH_COMMANDS } = ctx
  const panelCache = new Map()
  let lastCols = 0, lastRows = 0
  let lastConvKey = "", lastConvCols = 0, lastConvScroll = -1
  const convLineCache = []
  let renderRequested = false, renderTimer = null, lastRenderAt = 0

  function scheduleRender() {
    if (renderTimer) return
    const elapsed = performance.now() - lastRenderAt
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed)
    renderTimer = setTimeout(() => {
      renderTimer = null
      if (!renderRequested) return
      renderRequested = false
      lastRenderAt = performance.now()
      doRender()
      if (renderRequested) scheduleRender()
    }, delay)
  }

  function render() {
    if (renderRequested) return
    renderRequested = true
    process.nextTick(() => scheduleRender())
  }

  function buildPanel(name, panelLayout, lines, cacheKey) {
    if (!panelLayout) {
      if (panelCache.has(name)) panelCache.delete(name)
      return null
    }
    const content = lines.join("\r\n")
    const cached = panelCache.get(name)
    const effectiveKey = cacheKey ?? content
    if (cached && cached.y === panelLayout.y && cached.h === panelLayout.h && cached.key === effectiveKey) return null
    const rows = []
    for (let i = 0; i < panelLayout.h; i++) {
      rows.push(`\x1b[${panelLayout.y + 1 + i};1H${lines[i] ?? ""}\x1b[K`)
    }
    panelCache.set(name, { y: panelLayout.y, h: panelLayout.h, key: effectiveKey })
    return rows.join("")
  }

  function layoutStructureChanged(layout) {
    for (const [name, cached] of panelCache) {
      const p = layout.panels[name] ?? null
      if (p == null) return true
      if (p.y !== cached.y || p.h !== cached.h) return true
    }
    return false
  }

  function doRender() {
    try {
      const startupCols = startupDims.cols, startupRows = startupDims.rows
      const dims = { cols: process.stdout.columns || startupCols, rows: process.stdout.rows || startupRows }
      const layout = computeLayout(state, dims)
      const { W, panels, inputLayout, inputOffset, boxLines, visibleTasks, allSubs, permPreviewLines, overlay } = layout

      const convLines = countConvLines(state, dims.cols)
      state.scroll = Math.min(state.scroll, Math.max(0, convLines - panels.conversation.h))
      if (overlay && panels.picker) {
        const winH = panels.picker.h - 1
        if (overlay.selectedLine < overlay.scroll) overlay.scroll = overlay.selectedLine
        if (overlay.selectedLine >= overlay.scroll + winH) overlay.scroll = overlay.selectedLine - winH + 1
      }
      if (state.ctxCache.len !== agent.history.length) {
        state.ctxCache = { len: agent.history.length, tokens: estimateTokens(agent.history) }
      }

      // Deferred upgrade notice — pop when no overlay is active
      if (ctx.pendingNoticeReady(state)) {
        const notice = state.pendingNotice
        state.pendingNotice = null
        ctx.showUpdateNotice(notice).catch((e) => pushLine(`[error] ${e.message}`, C.error))
      }

      // Terminal resize or panel layout shift → full redraw
      if (dims.cols !== lastCols || dims.rows !== lastRows || layoutStructureChanged(layout)) {
        lastCols = dims.cols; lastRows = dims.rows
        for (const [name, panelLayout] of Object.entries(panels)) {
          if (!panelLayout) { panelCache.delete(name); continue }
          const cached = panelCache.get(name)
          if (cached) { cached.y = panelLayout.y; cached.h = panelLayout.h }
        }
        const isStreaming = state.processing && !state.permission && !state.question && !state.picker
        const isWizard = state.wizard?.step === "provider"
        const { frame, cursorRow, cursorCol } = renderFrame(state, agent, { cols: dims.cols, rows: dims.rows, slashCommands: SLASH_COMMANDS })
        if (isStreaming) {
          process.stdout.write(ansi.syncUpdateStart + ansi.home + frame + ansi.clearToEnd + ansi.syncUpdateEnd + `\x1b[${cursorRow};${cursorCol}H${ansi.hideCursor}`)
        } else if (isWizard) {
          process.stdout.write(ansi.syncUpdateStart + ansi.home + frame + ansi.clearToEnd + ansi.syncUpdateEnd + ansi.hideCursor)
        } else {
          process.stdout.write(ansi.syncUpdateStart + ansi.home + frame + ansi.clearToEnd + ansi.syncUpdateEnd + `\x1b[${cursorRow};${cursorCol}H${ansi.hideCursor}`)
        }
        return
      }

      // ---- Incremental rendering (layout stable) ----
      const out = []
      const push = (s) => { if (s != null) out.push(s) }

      push(buildPanel("header", panels.header, [renderHeader(agent, dims.cols)]))
      push(buildPanel("status", panels.status, [renderStatus(state, agent, dims.cols, SLASH_COMMANDS)]))
      push(buildPanel("inputBox", panels.inputBox, renderInputBox(state, W, boxLines, dims.cols, inputLayout, inputOffset)))

      const convKey = convCacheKey(state)
      const convChanged = convKey !== lastConvKey || dims.cols !== lastConvCols || state.scroll !== lastConvScroll
      if (convChanged) {
        lastConvKey = convKey; lastConvCols = dims.cols; lastConvScroll = state.scroll
        const lines = renderConversation(state, dims.cols, panels.conversation.h, state.scroll)
        const y = panels.conversation.y + 1
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] !== convLineCache[i]) {
            out.push(`\x1b[${y + i};1H${lines[i]}\x1b[K`)
            convLineCache[i] = lines[i]
          }
        }
        if (convLineCache.length > lines.length) {
          for (let i = lines.length; i < convLineCache.length; i++) {
            out.push(`\x1b[${y + i};1H\x1b[K`)
          }
        }
        convLineCache.length = lines.length
      }

      push(buildPanel("todo", panels.todo, renderTodo(visibleTasks, dims.cols)))
      push(buildPanel("subagent", panels.subagent, renderSubagent(allSubs, W)))
      push(buildPanel("output", panels.output, renderOutput(state, W, panels.output?.h ?? 0),
        Object.values(state.outputPanels).filter(p => !p.done).map(p => p.text?.length ?? 0).join(",")))
      push(buildPanel("permission", panels.permission, renderPermission(permPreviewLines)))
      if (panels.queue) push(buildPanel("queue", panels.queue, [renderQueue(state, W)]))
      else panelCache.delete("queue")
      if (panels.picker) push(buildPanel("picker", panels.picker, renderPicker(state, dims.cols, panels.picker, overlay)))
      else panelCache.delete("picker")

      for (const p of Object.values(state.outputPanels)) {
        if (p._pendingDone) { p.done = true; delete p._pendingDone }
      }

      const cr = panels.inputBox.y + 1 + (inputLayout.cursorLine - inputOffset) + 1
      const cc = 3 + inputLayout.cursorCol
      const hasOverlay = state.permission || state.question || state.picker || state.wizard?.step === "provider"
      const cursorSuffix = hasOverlay ? "" : `\x1b[${cr};${cc}H${ansi.hideCursor}`

      if (out.length || cursorSuffix) process.stdout.write(ansi.syncUpdateStart + out.join("") + ansi.syncUpdateEnd + cursorSuffix)
    } catch (e) {
      // Don't let a render error crash the TUI
    }
  }

  return { render, scheduleRender }
}
