/** /exit command: exit TUI.
 *  ctx: { exit } — exit is the cleanup + process.exit callback injected by index.mjs */
export async function handleExitCommand(ctx) {
  ctx.exit()
}
