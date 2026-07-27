import { C } from "./ansi.mjs"

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
