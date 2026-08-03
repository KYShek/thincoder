import { C } from "./ansi.mjs"

/** Read text from system clipboard. Returns empty string on failure. */
export async function readClipboardText() {
  try {
    const { execFile } = await import("node:child_process")
    const isWin = process.platform === "win32"
    const isMac = process.platform === "darwin"
    if (isWin) {
      return await new Promise((resolve) => execFile("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)))
    } else if (isMac) {
      return await new Promise((resolve) => execFile("pbpaste", [], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)))
    } else {
      return await new Promise((resolve) => execFile("xclip", ["-selection", "clipboard", "-o"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)))
    }
  } catch {
    return ""
  }
}

/** Insert pasted text into the active text target.
 *  Free-text question active → append to its answer (single-line field: newlines stripped).
 *  Options question active → ignore (no text field; must not leak into the input box).
 *  Otherwise → splice into the main input box at cursor (newlines kept, tabs → 2 spaces).
 *  Shared by bracketed paste (stdin data handler) and Ctrl+V clipboard read,
 *  so pasted content lands in the same place regardless of how the terminal delivered it. */
export function insertPastedText(state, rawText) {
  if (!rawText) return
  const q = state.question
  if (q) {
    if (q.options.length > 0) return
    q.answer = (q.answer ?? "") + rawText.replace(/[\r\n]+/g, "")
    return
  }
  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ")
  const chars = [...text]
  state.input.splice(state.cursor, 0, ...chars)
  state.cursor += chars.length
}

/** Translate Shift+Enter sequences from keyboard-enhanced terminals into the Alt+Enter path.
 *  kitty/CSI-u: \x1b[13;2u; xterm modifyOtherKeys: \x1b[27;2;13~. Both become \x1b\r,
 *  which readline parses reliably as meta+return (the multiline branch in key-handler).
 *  Terminals without enhancement send a bare \r for Shift+Enter — nothing to translate
 *  (degrades to a normal submit; Alt+Enter remains the fallback). */
export function translateShiftEnter(text) {
  return text.replace(/\x1b\[13;2u/g, "\x1b\r").replace(/\x1b\[27;2;13~/g, "\x1b\r")
}

/** Ctrl+V / Alt+V: read clipboard image → write temp file in working directory → insert read_image command into input box.
 *  Extracted from index.mjs.
 *  ctx: { agent, state, pushLine, render } */
export async function pasteClipboardImage(ctx) {
  const { agent, state, pushLine, render } = ctx
  const { execFile } = await import("node:child_process")
  const { mkdir, stat, unlink } = await import("node:fs/promises")
  const { join } = await import("node:path")

  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => { if (err) reject(err); else resolve(stdout) })
  })

  const dest = join(agent.cwd, `.thincoder-paste-${Date.now()}.png`)
  const isWin = process.platform === "win32"
  const isMac = process.platform === "darwin"

  try {
    if (isWin) {
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { [System.Windows.Forms.Clipboard]::GetImage().Save('${dest.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`
      await run("powershell", ["-NoProfile", "-Command", psScript])
    } else if (isMac) {
      const script = `try; set f to (POSIX file "${dest}"); set img to the clipboard as «class PNGf»; set fd to open for access f with write permission; write img to fd; close access fd; end try`
      await run("osascript", ["-e", script])
    } else {
      await run("bash", ["-c", `xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null || { which wl-paste >/dev/null 2>&1 && wl-paste -t image/png > "${dest}" 2>/dev/null; } || exit 1`])
    }
  } catch {
    pushLine("Clipboard does not contain an image, or clipboard access failed", C.dim)
    try { await unlink(dest) } catch {}
    return
  }

  const st = await stat(dest).catch(() => null)
  if (!st || st.size === 0) {
    pushLine("Clipboard does not contain an image, or clipboard access failed", C.dim)
    try { await unlink(dest) } catch {}
    return
  }

  const cmd = `read_image ${dest}`
  state.input.splice(state.cursor, 0, ...[...cmd])
  state.cursor += cmd.length
  pushLine(`[image pasted → ${dest}]`, C.tool)
  render()
}
