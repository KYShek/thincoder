/**
 * tui-render.mjs — terminal display utilities (pure functions, zero dependencies)
 * Character width calculation, CJK/emoji typesetting, text wrapping, markdown table reformatting.
 */

/** Character display width: CJK/emoji count as 2, combining characters as 0, rest as 1 */
export function charWidth(cp) {
  if (
    (cp >= 0x300 && cp <= 0x36f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // zero-width
    cp === 0xfe0f // emoji variation selector
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  ) {
    return 2
  }
  return 1
}

/** Compute the display width of a string (CJK characters count as 2) */
export function stringWidth(text) {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0))
  return w
}

/** Slice by display width */
export function sliceByWidth(text, maxWidth) {
  let w = 0
  let out = ""
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > maxWidth) break
    w += cw
    out += ch
  }
  return out
}

/** Right-pad by display width */
function padByWidth(text, width) {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)))
}

// ---------------------------------------------------------------- markdown table reformatting

const isTableRow = (line) => (line.match(/\|/g) ?? []).length >= 2
const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")

/**
 * Identify markdown table blocks in text, reformat by display width (fix CJK misalignment).
 * width is the available display width; over-wide tables shrink columns. Non-table lines are kept as-is.
 */
export function formatTables(text, width) {
  const lines = text.split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const block = [lines[i], lines[i + 1]]
      i += 2
      while (i < lines.length && isTableRow(lines[i])) {
        block.push(lines[i])
        i++
      }
      out.push(...renderTable(block, width))
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out
}

function renderTable(block, width) {
  const rows = block.map((line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim()),
  )
  const colCount = Math.max(...rows.map((r) => r.length))
  for (const r of rows) while (r.length < colCount) r.push("")

  // Column widths: content first; if too wide, shrink from widest column (down to at least 3)
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )
  const borders = colCount * 3 + 1 // " │ " separators + leading/trailing |
  while (widths.reduce((a, b) => a + b, 0) + borders > width && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest]--
  }

  // Cell rendering: sliceByWidth truncates (single-line for header), padByWidth pads
  const fmtCell = (text, ci) => padByWidth(sliceByWidth(text, widths[ci]), widths[ci])
  const fmtRow = (cells) => "│ " + cells.map((c, i) => fmtCell(c, i)).join(" │ ") + " │"

  // separator line
  const separator = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤"

  const out = []
  // Header: single-line truncation (header labels are usually short, truncation beats wrapping)
  out.push(fmtRow(rows[0]))
  out.push(separator)

  // Data rows: over-long cells wrap by column width; one logical row may produce multiple display lines
  for (let r = 2; r < rows.length; r++) {
    // wrapText returns array of lines wrapped by width, preserving internal \n
    const wrapped = rows[r].map((cell, ci) => wrapText(cell, widths[ci]))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    for (let lineIdx = 0; lineIdx < height; lineIdx++) {
      out.push(fmtRow(wrapped.map((lines) => lines[lineIdx] ?? "")))
    }
  }

  return out
}

/** Input area layout: wrap input buffer into lines, also compute cursor (row, col) position (display width).
 *  Every line carries a 2-column prefix so all content left-edges align: first line gets the
 *  `▸ ` prompt, continuation lines (wrap or explicit \n) get 2 spaces. Content width is
 *  `width - 2` on every line. A trailing \n flushes an empty line so the cursor's row exists —
 *  without it the box wouldn't grow for multiline input and the cursor row would be out of range. */
export function layoutInput(chars, cursor, width) {
  const PROMPT = "\u25b8 "  // first-line prefix (display width 2)
  const CONT = "  "         // continuation prefix (width 2) — keeps left edge aligned
  const lines = []
  let cursorLine = 0
  let cursorCol = 0
  let cur = ""
  let col = 0
  let firstLine = true
  const avail = () => width - 2 // every line reserves 2 cols for its prefix
  const flush = () => {
    lines.push((firstLine ? PROMPT : CONT) + cur)
    firstLine = false
    cur = ""
    col = 0
  }
  for (let i = 0; i <= chars.length; i++) {
    const ch = chars[i]
    if (ch !== undefined && ch !== "\n") {
      const w = charWidth(ch.codePointAt(0))
      if (col + w > avail()) flush()
      if (i === cursor) {
        cursorLine = lines.length
        cursorCol = 2 + col
      }
      cur += ch
      col += w
    } else {
      if (i === cursor) {
        cursorLine = lines.length
        cursorCol = 2 + col
      }
      if (ch === "\n") flush()
    }
  }
  const endsWithNewline = chars.length > 0 && chars[chars.length - 1] === "\n"
  if (cur || lines.length === 0 || endsWithNewline) flush()
  return { lines, cursorLine, cursorCol }
}

/**
 * Display sanitization: control characters can break terminal grid math (\r carriage return overwrite,
 * \t width misjudgment causing entire frame misalignment, ANSI/bell screen floods).
 * Display-layer only — raw tool results the model sees are unchanged; dirty displays already in session
 * are also cleaned during replay.
 */
const ANSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g
export function sanitizeDisplay(s) {
  return s
    .replace(ANSI_SEQUENCE_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n+$/, "")
}

/** Wrap text by display width (preserving \n), returns array of lines */
export function wrapText(text, width) {
  const lines = []
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      lines.push("")
      continue
    }
    let line = rawLine
    while (stringWidth(line) > width) {
      const head = sliceByWidth(line, width)
      lines.push(head)
      line = line.slice([...head].length)
    }
    lines.push(line)
  }
  return lines
}
