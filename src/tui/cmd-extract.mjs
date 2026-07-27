/** /extract command: extract knowledge from current session.
 *  ctx: { runDistill } */
export async function handleExtractCommand(ctx) {
  await ctx.runDistill()
}
