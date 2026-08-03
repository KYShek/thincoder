/**
 * markdown.mjs — lightweight inline markdown rendering for the TUI display layer.
 *
 * Zero dependencies, display-only: turns raw markdown markers into ANSI styling so
 * model replies stop showing literal `**`, `##`, backtick markers (IK5VW3).
 *
 * Design constraints:
 * - Operates on ALREADY-WRAPPED single lines (call after wrapText): inserting ANSI
 *   here cannot break width math, because wrapping already happened.
 * - Uses narrow-scope SGR resets (22 = bold off, 27 = reverse off, 29 = strikethrough off)
 *   instead of reset(0), so the line's base color (C.text etc.) survives.
 * - Code spans are extracted FIRST: anything inside backticks is styled as code and
 *   its `**`/`__` markers are NOT interpreted (markdown semantics).
 * - Unclosed markers are left as-is (streaming safety: mid-token `**bo` renders literally).
 */

const BOLD = "\x1b[1m"
const BOLD_OFF = "\x1b[22m"
const REVERSE = "\x1b[7m"
const REVERSE_OFF = "\x1b[27m"
const STRIKE = "\x1b[9m"
const STRIKE_OFF = "\x1b[29m"

/** Render inline markers on a single text line: `code` spans, **bold**, __bold__, ~~strike~~. */
export function renderMarkdownInline(line) {
  if (!line || line.indexOf("*") === -1 && line.indexOf("`") === -1 && line.indexOf("_") === -1 && line.indexOf("~") === -1) {
    return line
  }

  // Split on backticks: even indexes are plain text (bold/strike processed),
  // odd indexes are code spans (styled as-is, markers inside untouched).
  const parts = line.split("`")
  let out = ""
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += REVERSE + parts[i] + REVERSE_OFF
    } else {
      out += parts[i]
        .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/__([^_\n]+)__/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/~~([^~\n]+)~~/g, `${STRIKE}$1${STRIKE_OFF}`)
    }
  }
  return out
}

/** Render a heading line: strip leading `#` markers and bold the whole line. Returns original when not a heading. */
export function renderMarkdownHeading(line) {
  const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
  if (!m || !m[2]) return line
  return `${BOLD}${m[2]}${BOLD_OFF}`
}
