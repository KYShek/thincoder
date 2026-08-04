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
import { resolve } from "node:path"
import { loadConfig } from "./config.mjs"
import { assembleAgent } from "./cli/make-agent.mjs"
import { createAcpServer, ACP_ERRORS } from "./acp/transport.mjs"
import { createAcpSession } from "./acp/session.mjs"
import { replayHistory } from "./acp/bridge.mjs"
import { listSlots, loadSession, applySession, deleteSlot, sessionPath, normalizeCwd, isLegacyTransient } from "./session.mjs"

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

/** Load a specific slot file (not the active one) — session/load by id.
 *  Same validation as loadSession: version 1/2 + legacy-transient filtering
 *  (pre-filtering slot files must not leak machine lines into the replay). */
function loadSlotFile(cwd, slot) {
  const path = `${sessionPath(cwd)}.${slot}`
  try {
    const data = JSON.parse(readFileSync(path, "utf8"))
    if (data?.version !== 1 && data?.version !== 2) return null
    if (!Array.isArray(data.history)) return null
    data.history = data.history.filter((m) => !isLegacyTransient(m))
    return data
  } catch {
    return null
  }
}

/**
 * Apply a session-level config option to the agent instance (memory only —
 * the session's own runtime state, last-write-wins; not persisted to config.json).
 * Returns true when the configId is known.
 */
function applyConfigOption(agent, configId, value) {
  switch (configId) {
    case "model": {
      if (typeof value !== "string" || !value.trim()) return false
      if (!agent.provider) return false // nothing to configure
      // Split on the FIRST colon only — model names may contain colons.
      const ci = value.indexOf(":")
      const provider = ci >= 0 ? value.slice(0, ci) : null
      const model = (ci >= 0 ? value.slice(ci + 1) : value).trim()
      if (provider && provider !== agent.provider.name) agent.provider.name = provider
      agent.provider.model = model
      return true
    }
    case "thinking": {
      if (typeof value !== "boolean" || !agent.provider) return false
      agent.provider.thinking = value ? { type: "enabled" } : { type: "disabled" }
      return true
    }
    case "mode": {
      if (value !== "plan" && value !== "normal") return false
      agent.planMode = value === "plan"
      return true
    }
    default:
      return false
  }
}

/** Config is "configured" when the active provider has a resolvable API key (env fallback included). */
export function defaultIsConfigured() {
  try {
    return !!loadConfig().provider?.apiKey?.trim()
  } catch {
    return false
  }
}

/** M1/M2 session factory: one agent per session, built from the process cwd (single-cwd model).
 *  `id` is the ACP session id — it is baked into the callbacks at construction time
 *  (buildAcpCallbacks closure), so it must be known BEFORE createAcpSession runs.
 *  `request` is the transport's reverse-RPC channel (permissions + fs routing). */
export async function defaultCreateSession({ id, notify, request, log }) {
  const agent = await assembleAgent()
  return createAcpSession({ id, agent, notify, request, log })
}

/**
 * Build the ACP method handlers. Returns { handlers, sessions, notifyRef } —
 * notifyRef.current is set by runAcpServer once the transport exists; sessions
 * are created lazily (session/new), by which time the reference is live.
 * @param {{ version?: string, notify?: (method, params) => void, log?: (s: string) => void,
 *           isConfigured?: () => boolean, createSession?: (ctx) => Promise<object> }} deps
 */
export function buildAcpHandlers({
  version = VERSION,
  notify = () => {},
  log = () => {},
  isConfigured = defaultIsConfigured,
  createSession = defaultCreateSession,
  cwd = () => process.cwd(),
}) {
  const getCwd = cwd
  const notifyRef = { current: notify }
  const requestRef = { current: async () => { throw new Error("no request channel") } }
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
        if (params.cwd !== undefined && typeof params.cwd !== "string") {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: "cwd must be a string" } }
        }
        // Normalized comparison: resolve() collapses trailing slashes, and
        // normalizeCwd().toLowerCase() makes the check case-insensitive on
        // Windows (drive letter + path — a client sending "c:\users\…" vs
        // process.cwd() "C:\Users\…" must match). The ternary is load-bearing:
        // resolve(undefined) throws TypeError. Note: `requested` never feeds
        // any path operation — the agent always runs in getCwd() — so a
        // case-insensitive match on case-sensitive platforms is harmless.
        const norm = (p) => normalizeCwd(p).toLowerCase()
        const requested = params.cwd ? resolve(params.cwd) : getCwd()
        if (norm(requested) !== norm(getCwd())) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `v1: cwd must equal the process working directory (${getCwd()})` } }
        }
        if (params.mcpServers?.length) {
          log(`[acp] MCP forwarding is M2 scope — ignoring ${params.mcpServers.length} server(s)`)
        }
        try {
          const id = String(nextId++)
          const session = await createSession({ id, notify: notifyRef.current, request: requestRef.current, log })
          // `id` is immutable after construction (baked into the callbacks) — never reassign.
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
        const blocks = Array.isArray(params?.content) ? params.content : []
        const text = blocks.find((b) => b?.type === "text")?.text ?? ""
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
          // Abort any in-flight turn first — the client is gone, the agent must
          // stop consuming LLM tokens and emitting notifications.
          found.session.cancel()
          sessions.delete(String(params.sessionId))
          log(`session ${params.sessionId} closed by client`)
        }
        return {}
      },

      // ─── M3: persisted slots (thincoder session archive) + config options ───

      "session/list": () => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const slots = listSlots(getCwd())
        return {
          sessions: slots.map((s) => ({
            id: String(s.slot),
            cwd: getCwd(), // single-cwd model (design §4.5)
            updatedAt: s.updatedAt ?? s.timestamp ?? 0,
            title: s.title ?? "",
            messageCount: s.messageCount ?? 0,
          })),
        }
      },

      "session/load": async (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const slot = Number(params.sessionId)
        if (!Number.isInteger(slot) || slot < 1) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `invalid session id: ${params.sessionId}` } }
        }
        const data = loadSlotFile(getCwd(), slot)
        if (!data) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `session ${slot} not found (corrupt or deleted)` } }
        }
        try {
          const id = String(nextId++)
          const session = await createSession({ id, notify: notifyRef.current, request: requestRef.current, log })
          applySession(session.agent, data)
          sessions.set(id, session)
          // Replay the human line (role → chunk mapping, design §4.5) so the
          // client renders the restored conversation.
          replayHistory({ sessionId: id, notify: notifyRef.current, history: data.history, log })
          log(`session ${slot} loaded as session ${id} (${data.history?.length ?? 0} messages replayed)`)
          return { id, cwd: getCwd(), configOptions: [{ configId: "model" }, { configId: "thinking" }, { configId: "mode" }] }
        } catch (e) {
          return { error: { code: ACP_ERRORS.INTERNAL.code, message: `failed to load session ${slot}: ${e.message}` } }
        }
      },

      "session/resume": async (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const slot = Number(params.sessionId)
        if (!Number.isInteger(slot) || slot < 1) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `invalid session id: ${params.sessionId}` } }
        }
        const data = loadSlotFile(getCwd(), slot)
        if (!data) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `session ${slot} not found (corrupt or deleted)` } }
        }
        try {
          const id = String(nextId++)
          const session = await createSession({ id, notify: notifyRef.current, request: requestRef.current, log })
          applySession(session.agent, data)
          sessions.set(id, session)
          // resume: no history replay — the client keeps its own rendering.
          log(`session ${slot} resumed as session ${id} (no replay)`)
          return { id, cwd: getCwd(), configOptions: [{ configId: "model" }, { configId: "thinking" }, { configId: "mode" }] }
        } catch (e) {
          return { error: { code: ACP_ERRORS.INTERNAL.code, message: `failed to resume session ${slot}: ${e.message}` } }
        }
      },

      "session/delete": (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const slot = Number(params.sessionId)
        if (!Number.isInteger(slot) || slot < 1) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `invalid session id: ${params.sessionId}` } }
        }
        // Only the persisted archive is removed; an active in-memory session
        // with the same id keeps running (design §4.5).
        if (!deleteSlot(getCwd(), slot)) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `session ${slot} not found` } }
        }
        log(`session ${slot} archive deleted`)
        return {}
      },

      "session/set_config_option": (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const found = findSession(params)
        if (found.error) return found
        const { configId, value } = params
        if (!configId || value === undefined) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: "set_config_option requires configId and value" } }
        }
        const applied = applyConfigOption(found.session.agent, configId, value)
        if (!applied) {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: `unknown configId: ${configId}` } }
        }
        // Last-write-wins on the internal state; notify the client of the change.
        notifyRef.current("session/update", {
          sessionId: String(params.sessionId),
          update: { sessionUpdate: "config_option_update", configId, value },
        })
        return {}
      },

      "session/set_mode": (params) => {
        if (!authenticated) return { error: ACP_ERRORS.AUTH_REQUIRED }
        const found = findSession(params)
        if (found.error) return found
        if (params.mode !== "plan" && params.mode !== "normal") {
          return { error: { ...ACP_ERRORS.INVALID_PARAMS, message: "mode must be plan or normal" } }
        }
        found.session.agent.planMode = params.mode === "plan"
        notifyRef.current("session/update", {
          sessionId: String(params.sessionId),
          update: { sessionUpdate: "current_mode_update", mode: params.mode },
        })
        return {}
      },
    },
    sessions,
    notifyRef,
    requestRef,
  }
}

/** `thincoder acp` — start the server and block until the client closes the pipe. */
export async function runAcpServer() {
  const log = (...a) => process.stderr.write(a.join(" ") + "\n")
  // Build handlers first, then wire the transport — no window where requests
  // hit an empty handler map. notifyRef/requestRef become live with the server.
  const built = buildAcpHandlers({ log })
  const server = createAcpServer(built.handlers, { log })
  built.notifyRef.current = server.notify
  built.requestRef.current = server.request
  log(`[acp] thincoder ${VERSION} — ACP v1 over stdio, waiting for initialize`)
  server.start()
}
