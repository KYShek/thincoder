/**
 * acp.mjs — `thincoder acp` entry: expose the thincoder agent over the
 * Agent Client Protocol (schema v1) on stdio, so ACP clients (Zed, JetBrains
 * AI Chat, Paseo) can drive sessions directly.
 *
 * M1 scope (see docs/design/ACP-CLIENT.md §9):
 *   initialize / authenticate / session/new / session/prompt / session/cancel / session/close
 * M2: tools + request_permission + fs reverse-RPC. M3: session load/resume/list/delete + config options.
 *
 * Auth: reuse the terminal config (~/.thincoder/config.json) — a resolvable
 * provider API key means "configured". No account system; `logout` is absent.
 *
 * `isConfigured` / `createSession` are injectable for tests.
 */
import { readFileSync } from "node:fs"
import { loadConfig } from "./config.mjs"
import { assembleAgent } from "./cli/make-agent.mjs"
import { createAcpServer, ACP_ERRORS } from "./acp/transport.mjs"
import { createAcpSession } from "./acp/session.mjs"

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

/** Config is "configured" when the active provider has a resolvable API key (env fallback included). */
export function defaultIsConfigured() {
  try {
    return !!loadConfig().provider?.apiKey?.trim()
  } catch {
    return false
  }
}

/** M1 session factory: one agent per session, built from the process cwd (single-cwd model). */
export async function defaultCreateSession({ notify, log }) {
  const agent = await assembleAgent()
  return createAcpSession({ id: "?", agent, notify, log })
}

/**
 * Build the ACP method handlers. Returns { handlers, sessions } (sessions exposed for tests).
 * @param {{ version?: string, notify: (method, params) => void, log?: (s: string) => void,
 *           isConfigured?: () => boolean, createSession?: (ctx) => Promise<object> }} deps
 */
export function buildAcpHandlers({
  version = VERSION,
  notify,
  log = () => {},
  isConfigured = defaultIsConfigured,
  createSession = defaultCreateSession,
}) {
  const sessions = new Map()
  let nextId = 1
  let authenticated = false
  const findSession = (params) => {
    const s = sessions.get(String(params?.sessionId))
    if (!s) return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `unknown session ${params?.sessionId}` } }
    return { session: s }
  }

  return {
    handlers: {
      initialize: () => ({
        protocolVersion: 1,
        agentInfo: { name: "thincoder", version },
        authMethods: ["terminal"],
        capabilities: { fs: { read: true, write: true }, terminal: false },
      }),

      authenticate: () => {
        if (!isConfigured()) return { error: ACP_ERRORS.AUTH_REQUIRED }
        authenticated = true
        return { authenticated: true }
      },

      "session/new": async (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const cwd = params.cwd ?? process.cwd()
        if (cwd !== process.cwd()) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `v1: cwd must equal the process working directory (${process.cwd()})` } }
        }
        if (params.mcpServers?.length) {
          log(`[acp] MCP forwarding is M2 scope — ignoring ${params.mcpServers.length} server(s)`)
        }
        try {
          const session = await createSession({ notify, log })
          const id = String(nextId++)
          session.id = id
          sessions.set(id, session)
          return { id, configOptions: [{ configId: "model" }, { configId: "thinking" }, { configId: "mode" }] }
        } catch (e) {
          return { error: { code: ACP_ERRORS.INTERNAL.code, message: `failed to create session: ${e.message}` } }
        }
      },

      "session/prompt": async (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const found = findSession(params)
        if (found.error) return found
        const text = (params.content ?? []).find((b) => b?.type === "text")?.text ?? ""
        if (!text) return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: "prompt requires a text content block" } }
        try {
          await found.session.run(text)
          return { stopReason: "end_turn" }
        } catch (e) {
          // Cancelled/interrupted turns are not errors on the wire.
          if (e?.name === "AbortError" || e?.code === "ABORT_ERR") return { stopReason: "cancelled" }
          return { error: { code: ACP_ERRORS.INTERNAL.code, message: e?.message ?? String(e) } }
        }
      },

      "session/cancel": (params) => {
        const found = findSession(params)
        if (found.error) return found
        found.session.cancel()
        return {}
      },

      "session/close": (params) => {
        const found = findSession(params)
        if (!found.error) {
          sessions.delete(String(params.sessionId))
          log(`session ${params.sessionId} closed by client`)
        }
        return {}
      },
    },
    sessions,
  }
}

/** `thincoder acp` — start the server and block until the client closes the pipe. */
export async function runAcpServer() {
  const log = (...a) => process.stderr.write(a.join(" ") + "\n")
  const handlers = {}
  const server = createAcpServer(handlers, { log })
  Object.assign(handlers, buildAcpHandlers({ notify: server.notify, log }).handlers)
  log(`[acp] thincoder ${VERSION} — ACP v1 over stdio, waiting for initialize`)
  server.start()
}
