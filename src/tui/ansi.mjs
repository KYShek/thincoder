/**
 * tui-ansi.mjs — ANSI escape sequences and terminal color constants.
 * Zero dependencies, pure constant exports.
 */

export const ESC = "\x1b"
export const ansi = {
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  altBuffer: `${ESC}[?1049h`,
  mainBuffer: `${ESC}[?1049l`,
  mouseOn: `${ESC}[?1000h${ESC}[?1006h`,
  mouseOff: `${ESC}[?1000l${ESC}[?1006l`,
  bracketedPasteOn: `${ESC}[?2004h`,
  bracketedPasteOff: `${ESC}[?2004l`,
  home: `${ESC}[H`,
  clearLine: `${ESC}[K`,
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  fg: (n) => `${ESC}[${30 + n}m`,
  gray: `${ESC}[90m`,
}

export const C = {
  user: ansi.fg(4),
  assistant: ansi.fg(2),
  text: ansi.fg(7),
  reason: `${ESC}[2m`,
  tool: ansi.fg(6),
  error: ansi.fg(1),
  dim: ansi.gray,
  warn: ansi.fg(3),
}
