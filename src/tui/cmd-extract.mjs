/** /extract 命令：从当前会话提取知识。
 *  ctx: { runDistill } */
export async function handleExtractCommand(ctx) {
  await ctx.runDistill()
}
