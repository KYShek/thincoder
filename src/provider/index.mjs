/**
 * provider/index.mjs — backward-compatible re-export
 * import { chat } from "./provider" → resolves to this file
 */
export { chat, createProvider, listModels, stripImagesForTextModel } from "./core.mjs"
export { RETRYABLE_STATUS, _rateHooks, estimateText, estimateRequestTokens, rateGate, recordRate } from "./rate.mjs"
