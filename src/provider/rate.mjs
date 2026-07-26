/**
 * provider/rate.mjs — TPM/RPM 主动节流闸门
 * 滑动窗口记账，发请求前预检预算，超支则睡到窗口腾出空间。
 */

import { specForModel } from "../config.mjs"

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
export const MAX_RETRIES = 3
export const MAX_CONTINUATIONS = 3
export const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000]

/**
 * 测试钩子：睡眠/时钟/窗口长度可替换（离线测试不能真等 60s）。
 * 生产代码不要直接调 setTimeout/sleep，统一走这里。
 */
export const _rateHooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  windowMs: 60_000,
}

const rateWindows = new Map() // key → { tokens: [{ts, n}], requests: [ts] }

function rateKey(provider) {
  // 归一化：/beta 和 /v1 视为同一账户的同一限流窗口（DeepSeek prefix continuation 改 /beta 端点）
  const base = provider.baseURL.replace(/\/beta$/, "/v1")
  return `${base}|${provider.apiKey ?? ""}`
}

/** 粗估文本 token 数 */
export function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

/** 本次请求的 prompt 估算 */
export function estimateRequestTokens(body) {
  let tokens = 0
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") tokens += estimateText(m.content)
    if (typeof m.reasoning_content === "string") tokens += estimateText(m.reasoning_content)
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateText(tc.function?.name ?? "") + estimateText(tc.function?.arguments ?? "")
    }
  }
  if (body.tools) tokens += estimateText(JSON.stringify(body.tools))
  return tokens
}

/** 闸门：超预算则睡到窗口腾出空间 */
export async function rateGate(provider, estimated, onWait, signal) {
  const tpm = provider.tpm != null && estimated <= provider.tpm ? provider.tpm : null
  const rpm = provider.rpm ?? null
  if (tpm == null && rpm == null) return
  const w = rateWindows.get(rateKey(provider)) ?? { tokens: [], requests: [] }
  rateWindows.set(rateKey(provider), w)
  for (;;) {
    const now = _rateHooks.now()
    const cutoff = now - _rateHooks.windowMs
    w.tokens = w.tokens.filter((e) => e.ts > cutoff)
    w.requests = w.requests.filter((ts) => ts > cutoff)
    const usedTokens = w.tokens.reduce((s, e) => s + e.n, 0)
    const overTokens = tpm != null ? usedTokens + estimated - tpm : 0
    const overRequests = rpm != null ? w.requests.length + 1 - rpm : 0
    if (overTokens <= 0 && overRequests <= 0) break
    let waitMs = _rateHooks.windowMs
    if (overTokens > 0) {
      let freed = 0
      for (const e of w.tokens) {
        freed += e.n
        if (freed >= overTokens) {
          waitMs = Math.min(waitMs, e.ts + _rateHooks.windowMs - now)
          break
        }
      }
    }
    if (overRequests > 0) {
      waitMs = Math.min(waitMs, w.requests[overRequests - 1] + _rateHooks.windowMs - now)
    }
    waitMs = Math.max(waitMs, 50)
    onWait?.({ phase: "gate", seconds: Math.ceil(waitMs / 1000) })
    await _rateHooks.sleep(waitMs)
    if (signal?.aborted) return
  }
}

/** 记账：响应回来后按实测 usage 记 */
export function recordRate(provider, estimated, usage) {
  if (provider.tpm == null && provider.rpm == null) return
  const key = rateKey(provider)
  const w = rateWindows.get(key) ?? { tokens: [], requests: [] }
  const now = _rateHooks.now()
  const cutoff = now - _rateHooks.windowMs
  w.tokens = w.tokens.filter((e) => e.ts > cutoff)
  w.requests = w.requests.filter((ts) => ts > cutoff)
  w.requests.push(now)
  w.tokens.push({ ts: now, n: usage ? (usage.prompt_tokens ?? estimated) + (usage.completion_tokens ?? 0) : estimated })
  // 窗口已空则删条目，防长期跨 provider 配置时 Map 无界增长
  if (w.tokens.length === 0 && w.requests.length === 0) rateWindows.delete(key)
  else rateWindows.set(key, w)
}
