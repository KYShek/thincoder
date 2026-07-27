import { ansi, C } from "./ansi.mjs"

/** /restore 命令：列出 git checkpoint 并回滚到选中快照。
 *  ctx: { agent, openPicker, pushLine, pushLabel } */
export async function handleRestoreCommand(ctx) {
  const { agent, openPicker, pushLine, pushLabel } = ctx
  const { listCheckpoints, rewind, isGitRepo } = await import("../git/checkpoint.mjs")
  if (!isGitRepo(agent.cwd)) {
    pushLine("[rewind] not a git repository, checkpoints unavailable", C.error)
    return
  }
  const cps = await listCheckpoints(agent.cwd)
  if (cps.length === 0) {
    pushLine("(no checkpoints — created automatically before each task)", C.dim)
    return
  }
  const entries = [
    { type: "header", text: "Checkpoints (↑↓ select, Enter restore, Esc cancel)" },
    ...cps.slice(0, 12).map((cp) => ({
      type: "item",
      text: `${cp.id}  ${new Date(cp.time).toLocaleString()}  (+${cp.untracked} untracked files)`,
      id: cp.id,
    })),
  ]
  openPicker({
    title: "Restore Checkpoint",
    entries,
    onSelect: async (e) => {
      try {
        const summary = await rewind(agent.cwd, e.id)
        pushLabel(`❯ Rewind`, ansi.bold + C.warn)
        pushLine(`Restored to ${e.id}: patch ${summary.patchApplied ? "applied" : "none"}, deleted ${summary.deleted} new files, restored ${summary.restored} file(s)`, C.tool)
        pushLine("(current state saved as new checkpoint; /restore again to go back)", C.dim)
      } catch (error) {
        pushLine(`[rewind] ${error.message}`, C.error)
      }
    },
  })
}
