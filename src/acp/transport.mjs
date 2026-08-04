/**
 * transport.mjs — ACP NDJSON JSON-RPC 2.0 layer over stdio (zero dependencies).
 *
 * Wire format: one JSON object per line on stdin/stdout. stdout carries ONLY
 * protocol JSON (logs go to stderr — kimi log-guard parity). Error codes follow
 * JSON-RPC 2.0: -32600 parse, -32601 method not found, -32602 invalid params,
 * -32603 internal, -32000 authRequired (ACP extension).
 *
 * `write` is injectable for tests (defaults to process.stdout.write). `start()`
 * wires stdin + graceful shutdown (SIGINT/SIGTERM drain in-flight requests).
 */
import { createInterface } from "node:readline"

export const ACP_ERRORS = {
  PARSE: { code: -32600, message: "Parse error" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL: { code: -32603, message: "Internal error" },
  AUTH_REQUIRED: { code: -32000, message: "authRequired" },
}

/**
 * Create an ACP server.
 * @param {Record<string, (params, ctx) => Promise<any>|any>} handlers — method → handler.
 *   Handler return value becomes `result`; `{ error: ACP_ERRORS.X }` becomes an error response;
 *   a thrown error becomes -32603.
 * @param {{ write?: (s: string) => void, log?: (s: string) => void }} [opts]
 */
export function createAcpServer(handlers, { write = (s) => process.stdout.write(s), log = () => {} } = {}) {
  const state = { closed: false, inputClosed: false, inflight: new Set() }
  const send = (obj) => { if (!state.closed) write(JSON.stringify(obj) + "\n") }
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params })

  // stdin EOF only means "no more requests" — in-flight handlers must still
  // deliver their responses (e.g. session/new building an agent). Closed only
  // after the last handler settles.
  const drainIfDone = () => { if (state.inputClosed && state.inflight.size === 0) state.closed = true }

  async function handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      send({ jsonrpc: "2.0", id: null, error: ACP_ERRORS.PARSE })
      return
    }
    // Client-side notifications (no id) are out of v1 scope — ignore silently.
    if (!msg || typeof msg !== "object" || msg.method === undefined) return
    const handler = handlers[msg.method]
    if (!handler) {
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: ACP_ERRORS.METHOD_NOT_FOUND })
      return
    }
    const p = (async () => {
      try {
        const result = await handler(msg.params ?? {}, { notify, send, log })
        if (msg.id !== undefined) {
          if (result && typeof result === "object" && result.error) {
            send({ jsonrpc: "2.0", id: msg.id, error: result.error })
          } else {
            send({ jsonrpc: "2.0", id: msg.id, result })
          }
        }
      } catch (e) {
        log(`[acp] handler error: ${e?.message ?? e}`)
        if (msg.id !== undefined) {
          send({ jsonrpc: "2.0", id: msg.id, error: { ...ACP_ERRORS.INTERNAL, message: e?.message ?? String(e) } })
        }
      }
    })()
    state.inflight.add(p)
    // Track completion after the handler settles (keep the drain bookkeeping
    // outside the IIFE — inflight must reflect the request until it finishes).
    p.finally(() => { state.inflight.delete(p); drainIfDone() }).catch(() => {})
  }

  /** Wire stdin + shutdown handlers. Returns the notify fn for out-of-band pushes. */
  function start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    rl.on("line", (l) => { if (l.trim()) handleLine(l) })
    rl.on("close", () => { state.inputClosed = true; drainIfDone() })
    const shutdown = () => {
      log("[acp] shutting down — draining in-flight requests")
      Promise.all([...state.inflight]).then(() => { state.closed = true; process.exit(0) })
      setTimeout(() => process.exit(0), 2000).unref()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    return { notify, shutdown }
  }

  // handleLine/_state exposed for tests (drive without a real stdin).
  return { start, notify, handleLine, _state: state }
}
