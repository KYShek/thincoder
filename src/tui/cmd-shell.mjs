import { C } from "./ansi.mjs"

/** /shell command: show or set the bash-tool shell executable (persisted to config).
 *  ctx: { agent, pushLine, persistRaw }
 *  /shell                 → show current shell
 *  /shell <path|name>     → set (e.g. "C:\\Program Files\\Git\\bin\\bash.exe", "pwsh", "cmd")
 *  /shell reset           → back to system default (cmd on Windows, /bin/sh elsewhere) */
export async function handleShellCommand(ctx, args = []) {
  const input = args.join(" ").trim()
  const current = ctx.agent.config.shell
  if (!input) {
    const def = process.platform === "win32"
      ? "cmd (UTF-8 forced via chcp 65001 per command)"
      : "/bin/sh"
    ctx.pushLine(`Shell: ${current ? `\`${current}\`` : `(system default — ${def})`}`, C.text)
    ctx.pushLine(`Usage: /shell <path>  |  /shell reset  |  e.g. /shell "C:\\Program Files\\Git\\bin\\bash.exe"  |  /shell pwsh`, C.dim)
    return
  }
  if (input === "reset") {
    ctx.agent.config.shell = null
    await ctx.persistRaw((raw) => { raw.shell = null }).catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
    ctx.pushLine("Shell reset to system default.", C.text)
    return
  }
  ctx.agent.config.shell = input
  await ctx.persistRaw((raw) => { raw.shell = input }).catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
  ctx.pushLine(`Shell set to \`${input}\` — bash tool commands will run through it.`, C.text)
}
