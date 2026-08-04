import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { C } from "./ansi.mjs"

/** Platform shell candidates: { name, value (config.shell payload), detect() }.
 *  detect() returns truthy when the shell is available (static check, never throws). */
function platformShellCandidates() {
  const win = process.platform === "win32"
  const posix = !win
  const commandExists = (cmd) => {
    try {
      const r = spawnSync(win ? "where" : "sh", win ? [cmd] : ["-c", `command -v ${cmd}`], { encoding: "utf8", timeout: 3000 })
      return r.status === 0 && r.stdout.trim().length > 0
    } catch { return false }
  }
  const GIT_BASH_PATHS = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\bin\\bash.exe`,
  ]
  const candidates = []
  // System default always first
  candidates.push({ name: "System default", value: null, detect: () => true })
  if (win) {
    candidates.push({ name: "PowerShell (pwsh)", value: "pwsh", detect: () => commandExists("pwsh") })
    candidates.push({ name: "Windows PowerShell (powershell)", value: "powershell", detect: () => commandExists("powershell") })
    const gb = GIT_BASH_PATHS.find((p) => p && existsSync(p))
    if (gb) candidates.push({ name: `Git Bash (${gb})`, value: gb, detect: () => true })
    candidates.push({ name: "WSL bash (wsl)", value: "wsl", detect: () => commandExists("wsl") })
  } else {
    for (const sh of posix ? ["bash", "zsh", "fish"] : []) {
      candidates.push({ name: sh, value: sh, detect: () => commandExists(sh) })
    }
  }
  return candidates
}

/** /shell command: bash tool shell — platform-aware picker (default) or direct args.
 *  ctx: { agent, pushLine, showPicker, askQuestion, persistRaw }
 *  /shell                    → picker: available shells for this platform + custom path
 *  /shell <path|name>        → set directly (quotes stripped)
 *  /shell reset              → system default (case-insensitive) */
export async function handleShellCommand(ctx, args = []) {
  const { agent, pushLine, showPicker, askQuestion, persistRaw } = ctx
  // Strip surrounding quotes (slash args are whitespace-split; /shell "C:\Program Files\Git\bin\bash.exe"
  // would otherwise persist the literal quote characters and spawn would fail)
  const input = args.join(" ").trim().replace(/^["'](.+)["']$/, "$1")

  const persist = async (value) => {
    agent.config.shell = value
    await persistRaw((raw) => { raw.shell = value }).catch((e) => pushLine(`[error] ${e.message}`, C.error))
  }

  // ── Direct args ──
  if (input) {
    if (input.toLowerCase() === "reset") {
      await persist(null)
      pushLine("Shell reset to system default.", C.text)
      return
    }
    await persist(input)
    pushLine(`Shell set to \`${input}\` — bash tool commands will run through it.`, C.text)
    return
  }

  // ── Platform-aware picker ──
  const candidates = platformShellCandidates()
  const available = candidates.filter((c) => { try { return c.detect() } catch { return false } })
  const current = agent.config?.shell ?? null
  const entries = [
    { type: "header", text: "Shell — pick one (Esc exits)" },
    ...available.map((c) => ({
      type: "item",
      text: `${c.name}${c.value ? `  →  ${c.value}` : "  (cmd + UTF-8 on Windows / /bin/sh elsewhere)"}`,
      action: "pick",
      value: c.value,
      marker: (c.value ?? null) === current ? "●" : "",
    })),
    { type: "header", text: "Other" },
    { type: "item", text: "Custom path… (type any shell path/command)", action: "custom" },
  ]
  const defaultIndex = Math.max(0, available.findIndex((c) => (c.value ?? null) === current))
  const picked = await showPicker("Shell", entries, { defaultIndex })
  if (!picked) return // Esc

  if (picked.action === "custom") {
    const path = await askQuestion("Enter shell path or command (e.g. C:\\Program Files\\Git\\bin\\bash.exe, pwsh, cmd):")
    if (!path) return
    await persist(path.trim().replace(/^["'](.+)["']$/, "$1"))
    pushLine(`Shell set to \`${path.trim()}\` — bash tool commands will run through it.`, C.text)
    return
  }
  if (picked.value === null) {
    await persist(null)
    pushLine("Shell reset to system default.", C.text)
  } else {
    await persist(picked.value)
    pushLine(`Shell set to \`${picked.value}\` — bash tool commands will run through it.`, C.text)
  }
}
