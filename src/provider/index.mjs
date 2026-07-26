/**
 * provider/index.mjs — 后端兼容重导出
 * import { chat } from "./provider" → 自动解析到本文件
 */
export { chat, createProvider, listModels } from "./core.mjs"
export { RETRYABLE_STATUS, _rateHooks, estimateText, estimateRequestTokens, rateGate, recordRate } from "./rate.mjs"
