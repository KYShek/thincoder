import { C } from "./ansi.mjs"

/** /model 命令：打开模型选择器。
 *  ctx: { openModelPicker, pushLine } */
export async function handleModelCommand(ctx) {
  ctx.openModelPicker().catch((e) => ctx.pushLine(`[error] ${e.message}`, C.error))
}
