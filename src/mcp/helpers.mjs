/**
 * mcp/helpers.mjs — MCP 共享工具函数与常量
 */

export const INIT_TIMEOUT_MS = 30_000
export const CALL_TIMEOUT_MS = 120_000
export const ENDPOINT_WAIT_MS = 5_000

let nextRpcId = 0
export function rpcId() {
  return String(++nextRpcId)
}

export function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}

export function quoteArg(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function withAuthToken(wsUrl, authorization) {
  if (!authorization) return wsUrl
  const token = authorization.replace(/^Bearer\s+/i, "")
  const u = new URL(wsUrl)
  u.searchParams.set("token", token)
  return u.href
}

export function sanitizeToolName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}
