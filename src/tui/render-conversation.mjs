/**
 * render-conversation.mjs — conversation panel line builder
 * Extracted from render-frame.mjs.
 */
import { ansi, C } from "./ansi.mjs"
import { formatTables, sanitizeDisplay, wrapText } from "./render.mjs"
import { renderMarkdownInline, renderMarkdownHeading } from "./markdown.mjs"

let _convCache = { key: "", cols: 0, lines: [] }

export function convCacheKey(state) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  // expandedBlocks participates: expanding/folding a block must invalidate the cache
  const exp = state.expandedBlocks ? [...state.expandedBlocks].sort().join(",") : ""
  return `${state.lines.length}|${lastLine?.text.length ?? 0}|${state.streaming.length}|${state.reasoning.length}|${state.advisorStreaming?.length ?? 0}|${state._advisorThink?.length ?? 0}|${state.foldEnabled !== false ? "f" : "u"}|${exp}`
}

/** Fold marker line: bold-cyan icon + "click to …" phrase underlined (clickable affordance).
 *  No indent — flush with the content below it; the caller adds a blank line BEFORE it
 *  so the control line stands apart from unrelated content (reported UX). */
function foldHintLine(text, foldKey, srcIdx) {
  // Underline just the actionable phrase — link/button convention
  const withUnderline = text.replace(/(click to (?:expand|collapse))/, "\x1b[4m$1\x1b[24m")
  return { text: withUnderline, color: C.fold, _foldToggle: foldKey, _src: srcIdx }
}

/** Blank separator before a fold control line (uncolored — must not join consecutive-dim folding). */
function blankLine() {
  return { text: "", color: "" }
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

    // Long-message folding: ANY single line (main output C.text, thinking C.reason,
    // tool summaries C.dim — whatever wraps beyond LONG_FOLD_LINES display rows)
    // collapses to [first, "… N more — click/expand", last]. Main output and
    // thinking are the REAL long content; bidirectional folding (collapse markers
    // + click toggle) keeps them readable — the 0.12.7 dim-only restriction was a
    // temporary fix for the single-direction era and is now reverted. Keyed by the
    // source-line index (`long-${i}`) so the toggle survives re-renders.
    const LONG_FOLD_LINES = 12
    const longKey = `long-${i}`
    const folded = state.foldEnabled !== false && !state.expandedBlocks?.has(longKey)
    const block = []
    for (const line of formatTables(sanitizeDisplay(text), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        // Lightweight markdown display (IK5VW3): headings bold + inline markers styled.
        // Runs AFTER wrapping so the ANSI it inserts never skews width math.
        block.push({ text: renderMarkdownInline(renderMarkdownHeading(wrapped)), color: l.color, _foldId: l._foldId, _src: i })
      }
    }
    if (folded && block.length > LONG_FOLD_LINES) {
      // Folded state: blank line, then the ▶ control line at the block HEAD (flush
      // with content — reported: indented hint looked unrelated), then first/last.
      convLines.push(blankLine())
      convLines.push(foldHintLine(`▶ … ${block.length - 2} more lines — click to expand`, longKey, i))
      convLines.push(block[0])
      convLines.push(block[block.length - 1])
    } else if (block.length > LONG_FOLD_LINES) {
      // EXPANDED long block: blank line + ▼ control line at the HEAD, directly
      // before the content. DIM blocks must not re-trigger the consecutive-dim
      // folding below (folding stacked on folding — reported regression).
      if (l.color === C.dim) {
        for (const line of block) line._skipDimFold = true
      }
      convLines.push(blankLine())
      convLines.push(foldHintLine(`▼ … ${block.length} lines — click to collapse`, longKey, i))
      convLines.push(...block)
    } else {
      convLines.push(...block)
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
        convLines.push({ text: renderMarkdownInline(renderMarkdownHeading(wrapped)), color: C.text })
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
      // Expanded long-fold blocks are exempt — otherwise folding stacks on folding
      const hasExpandedLong = convLines.slice(i, j).some((l) => l._skipDimFold)
      if (blockLen > FOLD_LINES && !hasExpandedLong) {
        const foldKey = `fold-${foldCounter++}`
        if (state.foldEnabled !== false && !state.expandedBlocks?.has(foldKey)) {
          // Blank line + ▶ control line at the block HEAD (flush with content), then first two lines
          folded.push(blankLine())
          folded.push(foldHintLine(`▶ … ${blockLen - 2} more lines — click to expand`, foldKey))
          folded.push(convLines[i])
          if (blockLen > 2) folded.push(convLines[i + 1])
          i = j
          continue
        }
        // EXPANDED consecutive-dim block: blank + ▼ at the HEAD, then every line
        folded.push(blankLine())
        folded.push(foldHintLine(`▼ … ${blockLen} lines — click to collapse`, foldKey))
        for (let k = i; k < j; k++) folded.push(convLines[k])
        i = j
        continue
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

export { buildConvLines }

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
