/** /exit 命令：退出 TUI。
 *  ctx: { exit } — exit 是 index.mjs 注入的 cleanup + process.exit 回调 */
export async function handleExitCommand(ctx) {
  ctx.exit()
}
