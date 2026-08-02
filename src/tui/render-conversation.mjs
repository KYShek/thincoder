/**
 * render-conversation.mjs — conversation panel line builder
 * Extracted from render-frame.mjs.
 */
import { ansi, C } from "./ansi.mjs"
import { formatTables, sanitizeDisplay, wrapText } from "./render.mjs"

let _convCache = { key: "", cols: 0, lines: [] }

export function convCacheKey(state) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  return `${state.lines.length}|${lastLine?.text.length ?? 0}|${state.streaming.length}|${state.reasoning.length}|${state.advisorStreaming?.length ?? 0}|${state._advisorThink?.length ?? 0}|${state.foldEnabled !== false ? "f" : "u"}`
}

function highlightSearchMatches(text, query, matchesInLine, globalCurrentIndex, allMatches, lineIndex) {
  if (!matchesInLine || matchesInLine.length === 0 || !query) return text
  let result = ""
  let lastEnd = 0
  for (const startIdx of matchesInLine) {
    result += text.substring(lastEnd, startIdx)
    const endIdx = startIdx + query.length
    const matchedText = text.substring(startIdx, endIdx)

    // Find global index of this match
    const gIdx = allMatches.findIndex(m => m.lineIndex === lineIndex && m.charIndex === startIdx)

    if (gIdx === globalCurrentIndex) {
      result += `\x1b[7m${matchedText}\x1b[27m` // Reverse video for current
    } else {
      result += `\x1b[33m\x1b[4m${matchedText}\x1b[24m\x1b[39m` // Yellow underline for others
    }
    lastEnd = endIdx
  }
  result += text.substring(lastEnd)
  return result
}

function buildConvLines(state, cols) {
  const key = convCacheKey(state)
  if (_convCache.key === key && _convCache.cols === cols) return _convCache.lines

  const convLines = []
  for (let i = 0; i < state.lines.length; i++) {
    const l = state.lines[i]
    let text = l.text

    // Apply search highlighting
    if (state.search && state.search.query && l._searchMatches) {
      text = highlightSearchMatches(text, state.search.query, l._searchMatches, state.search.index, state.search.matches, i)
    }

    for (const line of formatTables(sanitizeDisplay(text), cols - 1)) {
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
  if (state._advisorThink || state.advisorStreaming) {
    const thinkLines = state._advisorThink ? sanitizeDisplay(state._advisorThink).split("\n") : []
    const mainLines = state.advisorStreaming
      ? formatTables(sanitizeDisplay(state.advisorStreaming), cols - 3)
      : []
    const allLines = [...thinkLines.map(l => ({ text: l, color: C.reason })), ...mainLines.map(l => ({ text: l, color: C.text }))]
    const truncated = allLines.length > 5
    if (truncated) convLines.push({ text: "│ …", color: C.dim })
    const shown = truncated ? allLines.slice(-5) : allLines
    for (const { text, color } of shown) {
      for (const wrapped of wrapText(text, cols - 3)) {
        convLines.push({ text: `│ ${wrapped}`, color })
      }
    }
  }
  if (state.streaming) {
    for (const line of formatTables(sanitizeDisplay(state.streaming), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: C.text })
      }
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
  for (let p = 0; p < pad; p++) out.push("")
  for (const l of visible) out.push(`${l.color ?? ""}${l.text}${ansi.reset}`)
  return out
}
