/**
 * mcp/transport-ws.mjs — MCP WebSocket transport
 */
import { rpcId, INIT_TIMEOUT_MS, CALL_TIMEOUT_MS, withTimeout, withAuthToken } from "./helpers.mjs"

export function wsTransport(wsUrl, extraHeaders = {}) {
  const pending = new Map()
  let closed = false
  let ws = null

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  const connect = () => {
    if (closed) throw new Error("MCP WebSocket connection closed")
    ws = new WebSocket(withAuthToken(wsUrl, extraHeaders.Authorization))

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`WebSocket connect timeout: ${wsUrl}`))
      }, INIT_TIMEOUT_MS)

      ws.addEventListener("open", () => {
        clearTimeout(timeout)
        resolve()
      })

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data.toString())
          const resolver = pending.get(msg.id)
          if (resolver) {
            pending.delete(msg.id)
            resolver(msg)
          }
        } catch { /* 非 JSON，忽略 */ }
      })

      ws.addEventListener("error", (event) => {
        clearTimeout(timeout)
        closed = true
        const errMsg = event.message || "WebSocket error"
        if (pending.size > 0) {
          failAll(errMsg)
        } else {
          reject(new Error(errMsg))
        }
      })

      ws.addEventListener("close", () => {
        clearTimeout(timeout)
        closed = true
        failAll("WebSocket closed")
      })
    })
  }

  const send = (method, params) => {
    if (closed) return Promise.reject(new Error("MCP WebSocket connection closed"))
    const id = rpcId()
    const promise = new Promise((resolve) => pending.set(id, resolve))
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    } catch (error) {
      pending.delete(id)
      return Promise.resolve({ id: null, error: { code: -32000, message: `ws send failed: ${error.message}` } })
    }
    return withTimeout(promise, CALL_TIMEOUT_MS).finally(() => pending.delete(id))
  }

  const notify = (method, params) => {
    if (!closed && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
    }
  }

  const close = () => {
    closed = true
    failAll("Connection closed")
    try { ws?.close() } catch { /* 忽略 */ }
  }

  return { send, notify, close, connect }
}
