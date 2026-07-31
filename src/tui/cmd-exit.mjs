/** /exit command: exit TUI (same path as Ctrl+C).
 *  ctx: { agent, state } */
import { saveSession, archiveCurrent } from "../session.mjs"
import { closeAllMcp } from "../mcp.mjs"
import { ansi } from "./ansi.mjs"

export async function handleExitCommand(ctx) {
  const { agent, state } = ctx
  // Same cleanup sequence as Ctrl+C in key-handler.mjs
  try {
    archiveCurrent(agent.cwd)
    saveSession(agent, state.lines)
  } catch { /* save failure shouldn't block exit */ }
  try { closeAllMcp(agent) } catch { /* exiting anyway */ }
  process.stdin.setRawMode(false)
  process.stdout.write(ansi.clearScreen + ansi.mouseOff + ansi.bracketedPasteOff + ansi.mainBuffer + ansi.showCursor + ansi.reset)
  // Exit synchronously — prevents post-handler render() from redrawing the TUI
  process.exit(0)
}
