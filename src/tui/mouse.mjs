/**
 * mouse.mjs — SGR mouse support: click parsing + hit-testing + line actions.
 *
 * Protocol (enabled at startup via \x1b[?1000h\x1b[?1006h):
 *   press:    \x1b[<b;col;rowM   (b=0 left, 64/65 wheel up/down — wheel handled upstream)
 *   release:  \x1b[<b;col;rowm   (ignored — actions fire on press)
 * Coordinates are 1-based; col comes FIRST in the sequence.
 *
 * Only left-click (button 0) is consumed. Everything else stays stripped
 * upstream (sequence fragments must never leak into the input box).
 */
import { computeLayout } from "./layout.mjs"
import { buildConvLines } from "./render-conversation.mjs"
import { sanitizeDisplay } from "./render.mjs"

/** Extract left-click presses from a chunk. Returns [{ col, row }] (1-based). */
export function parseMouseClicks(text) {
  const out = []
  for (const m of text.matchAll(/\x1b\[<0;(\d+);(\d+)M/g)) {
    out.push({ col: Number(m[1]), row: Number(m[2]) })
  }
  return out
}

/** Map a 0-based screen row to a conversation line index (same math as renderConversation). */
export function convGlobalIndex(convLen, convH, scroll) {
  const maxScroll = Math.max(0, convLen - convH)
  const clamped = Math.min(scroll, maxScroll)
  const end = convLen - clamped
  const start = Math.max(0, end - convH) // content shorter than the panel: rows start at 0
  return (localRow) => {
    if (localRow < 0 || localRow >= convH) return null
    const idx = start + localRow
    return idx >= 0 && idx < convLen ? idx : null
  }
}

/**
 * Handle a left-click at SGR (col, row) — 1-based terminal coordinates.
 * ctx: { state, render, showPicker, popPicker, pushLine }
 * Returns true when the click was consumed.
 */
export function handleMouseClick(ctx, col, row) {
  const { state, render } = ctx
  const r = row - 1 // 0-based screen row
  if (r < 0) return false
  const dims = { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }
  const layout = computeLayout(state, dims)
  const P = layout.panels

  // ── Picker: click an option = select it (skip the title row) ──
  if (state.picker && P.picker && r >= P.picker.y && r < P.picker.y + P.picker.h) {
    const p = state.picker
    const items = p.filteredItems ?? p.entries.filter((e) => e.type === "item")
    const winH = Math.max(1, P.picker.h - 1)
    const start = Math.max(0, Math.min(p.scroll, Math.max(0, p.lines.length - winH)))
    const localRow = r - P.picker.y - 1
    const lineEl = p.lines[start + localRow]
    if (lineEl && lineEl._row !== undefined && items[lineEl._row]) {
      ctx.popPicker(items[lineEl._row])
    }
    return true
  }

  // ── Conversation: fold-toggle line expands; a message line opens the action menu ──
  if (r >= P.conversation.y && r < P.conversation.y + P.conversation.h) {
    const convLines = buildConvLines(state, dims.cols)
    const gIdx = convGlobalIndex(convLines.length, P.conversation.h, state.scroll ?? 0)(r - P.conversation.y)
    if (gIdx === null) return false
    const lineEl = convLines[gIdx]
    if (!lineEl) return false

    // Click on a folded-block hint → expand it
    if (lineEl._foldToggle) {
      state.expandedBlocks ??= new Set()
      state.expandedBlocks.add(lineEl._foldToggle)
      render()
      return true
    }
    // Click on a message line → action menu
    if (lineEl._src !== undefined) {
      const src = state.lines[lineEl._src]
      if (src) {
        openLineMenu(ctx, src)
        return true
      }
    }
  }

  return false
}

/** Line action menu: copy / edit in input / (fold toggle if the source line folds). */
async function openLineMenu(ctx, srcLine) {
  const { state, render, showPicker, pushLine } = ctx
  const text = sanitizeDisplay(srcLine.text)
  const entries = [
    { type: "item", text: `📋 Copy line (${text.length} chars)`, action: "copy" },
    { type: "item", text: "✏️ Edit in input box", action: "edit" },
  ]
  const picked = await showPicker("Line actions", entries)
  if (!picked) return
  if (picked.action === "copy") {
    try {
      const { copyToClipboard } = await import("./clipboard.mjs")
      await copyToClipboard(text)
      pushLine(`[clipboard] copied ${text.length} chars`, (await import("./ansi.mjs")).C.dim)
    } catch (e) {
      pushLine(`[clipboard] copy failed: ${e.message}`, (await import("./ansi.mjs")).C.error)
    }
    render()
  } else if (picked.action === "edit") {
    state.input = [...text]
    state.cursor = state.input.length
    render()
  }
}
