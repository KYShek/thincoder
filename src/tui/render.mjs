/**
 * tui-render.mjs — 终端显示工具（纯函数，零依赖）
 * 字符宽度计算、CJK/emoji 排版、文本折行、markdown 表格重排。
 */

/** 字符显示宽度：CJK/emoji 计 2，组合字符计 0，其余计 1 */
export function charWidth(cp) {
  if (
    (cp >= 0x300 && cp <= 0x36f) || // 组合变音符
    (cp >= 0x200b && cp <= 0x200f) || // 零宽
    cp === 0xfe0f // emoji 变体选择符
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

export function stringWidth(text) {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0))
  return w
}

/** 按显示宽度裁剪 */
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

/** 按显示宽度右补空格 */
function padByWidth(text, width) {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)))
}

// ---------------------------------------------------------------- markdown 表格重排

const isTableRow = (line) => (line.match(/\|/g) ?? []).length >= 2
const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")

/**
 * 识别文本中的 markdown 表格块，按显示宽度重排 (修 CJK 错位）。
 * width 为可用显示宽度；过宽的表格按列收缩。非表格行原样保留。
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

  // 列宽：先按内容，超宽则从最宽列开始收缩 (收缩到至少 3）
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )
  const borders = colCount * 3 + 1 // " │ " 分隔 + 首尾 |
  while (widths.reduce((a, b) => a + b, 0) + borders > width && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest]--
  }

  // 单元格渲染：sliceByWidth 截断 (表头单行），padByWidth 补齐
  const fmtCell = (text, ci) => padByWidth(sliceByWidth(text, widths[ci]), widths[ci])
  const fmtRow = (cells) => "│ " + cells.map((c, i) => fmtCell(c, i)).join(" │ ") + " │"

  // 分隔线
  const separator = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤"

  const out = []
  // 表头：单行截断 (表头通常是短标签，折行不如截断直观）
  out.push(fmtRow(rows[0]))
  out.push(separator)

  // 数据行：过长单元格按列宽折行，一个逻辑行可能对应多条显示行
  for (let r = 2; r < rows.length; r++) {
    // wrapText 返回按 width 折行后的行数组，保留内部 \n
    const wrapped = rows[r].map((cell, ci) => wrapText(cell, widths[ci]))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    for (let lineIdx = 0; lineIdx < height; lineIdx++) {
      out.push(fmtRow(wrapped.map((lines) => lines[lineIdx] ?? "")))
    }
  }

  return out
}

/** 输入区布局：把输入缓冲折行，同时算出光标的 (行, 列) 位置 (显示宽度） */
export function layoutInput(chars, cursor, width) {
  const PROMPT = "\u25b8 "
  const lines = []
  let cursorLine = 0
  let cursorCol = 0
  let cur = ""
  let col = 0
  let firstLine = true
  const avail = () => (firstLine ? width - 2 : width)
  const flush = () => {
    lines.push((firstLine ? PROMPT : "") + cur)
    firstLine = false
    cur = ""
    col = 0
  }
  for (let i = 0; i <= chars.length; i++) {
    if (i === cursor) {
      cursorLine = lines.length
      cursorCol = (firstLine ? 2 : 0) + col
    }
    const ch = chars[i]
    if (ch === undefined) break
    if (ch === "\n") {
      flush()
      continue
    }
    const w = charWidth(ch.codePointAt(0))
    if (col + w > avail()) flush()
    cur += ch
    col += w
  }
  if (cur || lines.length === 0) flush()
  return { lines, cursorLine, cursorCol }
}

/**
 * 显示净化：控制字符会破坏终端网格数学 (\r 回车覆盖、\t 宽度误判致整帧错位、ANSI/响铃冲屏）。
 * 只动显示层——模型看到的工具结果原文不变；session 里已存的脏 display 回放时也经此净化。
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

/** 文本按宽度折行 (保留 \n），返回行数组 */
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
