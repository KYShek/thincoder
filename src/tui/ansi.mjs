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
  keyboardPush: `${ESC}[>1u`,   // kitty keyboard protocol: push disambiguate mode (Shift+Enter → CSI-u)
  keyboardPop: `${ESC}[<u`,     // pop keyboard mode (restore terminal defaults on exit)
  modifyOtherKeysOn: `${ESC}[>4;2m`,  // xterm modifyOtherKeys level 2 (Shift+Enter → \x1b[27;2;13~), mintty/Git Bash path
  modifyOtherKeysOff: `${ESC}[>4m`,   // reset modifyOtherKeys
  home: `${ESC}[H`,
  clearLine: `${ESC}[K`,
  clearToEnd: `${ESC}[J`,
  clearScreen: `${ESC}[2J`,
  saveCursor: `${ESC}7`,      // DECSC — save cursor position
  restoreCursor: `${ESC}8`,   // DECRC — restore cursor position
  syncUpdateStart: `${ESC}[?2026h`, // DECSET 2026 — buffer output until syncUpdateEnd
  syncUpdateEnd: `${ESC}[?2026l`,   // DECRST 2026 — flush buffered output atomically
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
  advisor: `${ESC}[92m`,  // bright green — visible on dark backgrounds
  fold: `${ESC}[2m${ESC}[37m`,   // dim white — fold hints
}
