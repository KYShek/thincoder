/** /exit command: exit TUI (same path as Ctrl+C).
 *  Direct synchronous process.exit — prevents the post-handler render()
 *  from redrawing the TUI over the cleaned terminal. The actual cleanup
 *  (saveSession + closeMcp + terminal reset) runs once
 *  via the process.on("exit") handler registered in index.mjs.
 */
export async function handleExitCommand(_ctx) {
  process.exit(0)
}
