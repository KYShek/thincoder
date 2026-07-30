/**
 * render-conversation.mjs — conversation panel line builder
 * Extracted from render-frame.mjs.
 */
import { C } from "./ansi.mjs"
import { formatTables, sanitizeDisplay, wrapText } from "./render.mjs"

let _convCache = { key: "", cols: 0, lines: [] }

export function convCacheKey(state) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  return `${state.lines.length}|${lastLine?.text.length ?? 0}|${state.streaming.length}|${state.reasoning.length}|${Object.keys(state.toolStreams).length}|${state.foldEnabled !== false ? "f" : "u"}`
}

function buildConvLines(state, cols) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  const key = convCacheKey(state)
  if (_convCache.key === key && _convCache.cols === cols) return _convCache.lines

  const convLines = []
  for (const l of state.lines) {
    for (const line of formatTables(sanitizeDisplay(l.text), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: l.color, _foldId: l._foldId })
      }
    }
  }
  if (state.reasoning) {
    for (const wrapped of wrapText(sanitizeDisplay(state.reasoning), cols - 1)) {
      convLines.push({ text: wrapped, color: C.reason })
    }
  }
  if (state.streaming) {
    for (const line of formatTables(sanitizeDisplay(state.streaming), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: C.text })
      }
    }
  }
  const allStreams = Object.values(state.toolStreams).join("")
  if (allStreams) {
    const tail = sanitizeDisplay(allStreams.slice(-4000))
    for (const wrapped of wrapText(tail, cols - 1)) {
      convLines.push({ text: wrapped, color: C.dim })
    }
  }

  // Fold long blocks (> 8 consecutive dim lines)
  const FOLD_LINES = 8
  let foldCounter = 0
  const folded = []
  let i = 0
  while (i < convLines.length) {
    const line = convLines[i]
    if (line.color === C.dim) {
      let j = i
      while (j < convLines.length && convLines[j].color === C.dim) j++
      const blockLen = j - i
      if (blockLen > FOLD_LINES) {
        const foldKey = `fold-${foldCounter++}`
        if (state.foldEnabled !== false && !state.expandedBlocks?.has(foldKey)) {
          folded.push(convLines[i])
          if (blockLen > 2) folded.push(convLines[i + 1])
          folded.push({ text: `  … ${blockLen - 2} more lines — Enter to expand`, color: C.fold, _foldToggle: foldKey })
          i = j
          continue
        }
      }
    }
    folded.push(line)
    i++
  }

  _convCache = { key, cols, lines: folded }
  return folded
}

export function countConvLines(state, cols) {
  return buildConvLines(state, cols).length
}

export function renderConversation(state, cols, visibleH, scroll) {
  const convLines = buildConvLines(state, cols)
  const maxScroll = Math.max(0, convLines.length - visibleH)
  const clamped = Math.min(scroll, maxScroll)
  const end = convLines.length - clamped
  const visible = convLines.slice(Math.max(0, end - visibleH), end)
  const pad = visibleH - visible.length
  const out = []
  for (const l of visible) out.push(`${l.color ?? ""}${l.text}${C.reset}`)
  for (let p = 0; p < pad; p++) out.push("~")
  return out
}
