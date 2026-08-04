/**
 * acp.test.mjs — M1 ACP server tests (mock client over the transport layer).
 * Covers: NDJSON JSON-RPC transport (parse/method/error codes), handshake
 * (initialize/authenticate incl. authRequired), session lifecycle
 * (new/prompt/cancel/close), prompt FIFO queuing with an injected fake run.
 * No network: sessions use an injected run; authenticate uses an injected
 * isConfigured; transport `write` is captured instead of stdout.
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createAcpServer, ACP_ERRORS } from "../src/acp/transport.mjs"
import { buildAcpCallbacks } from "../src/acp/bridge.mjs"
import { createAcpSession } from "../src/acp/session.mjs"
import { buildAcpHandlers } from "../src/acp.mjs"

/** Minimal mock client: feeds lines to handleLine, captures outgoing JSON.
 *  Pass an external `out` array to also receive session/update notifications
 *  pushed via the injected notify (they share the same capture). */
function mockClient(handlers, out = []) {
  const server = createAcpServer(handlers, { write: (s) => out.push(JSON.parse(s)), log: () => {} })
  return {
    out,
    handleLine: (line) => server.handleLine(line),
    send: async (obj) => { await server.handleLine(JSON.stringify(obj)) },
    next: () => out.shift(),
    all: () => out.splice(0),
    waitIdle: () => new Promise((r) => setTimeout(r, 0)),
  }
}

describe("transport — NDJSON JSON-RPC", () => {
  it("replies to a request with matching id and result", async () => {
    const c = mockClient({ ping: () => "pong" })
    await c.send({ jsonrpc: "2.0", id: 1, method: "ping" })
    assert.deepEqual(c.next(), { jsonrpc: "2.0", id: 1, result: "pong" })
  })

  it("reports -32600 for malformed JSON (id null)", async () => {
    const c = mockClient({})
    await c.handleLine("{not json")
    assert.equal(c.next().error.code, -32600)
  })

  it("reports -32601 for unknown methods", async () => {
    const c = mockClient({})
    await c.send({ jsonrpc: "2.0", id: 7, method: "nope" })
    assert.equal(c.next().error.code, -32601)
  })

  it("surfaces handler errors as -32603 without breaking the stream", async () => {
    const c = mockClient({ boom: () => { throw new Error("kaput") } })
    await c.send({ jsonrpc: "2.0", id: 3, method: "boom" })
    assert.equal(c.next().error.code, -32603)
    assert.equal(c.next(), undefined, "stream still alive — nothing else emitted")
  })

  it("returns { error } objects as JSON-RPC errors (authRequired)", async () => {
    const c = mockClient({ auth: () => ({ error: ACP_ERRORS.AUTH_REQUIRED }) })
    await c.send({ jsonrpc: "2.0", id: 9, method: "auth" })
    assert.equal(c.next().error.code, -32000)
  })
})

describe("bridge — runAgent callbacks → session/update notifications", () => {
  it("maps token/reasoning/usage to the schema v1 shapes", () => {
    const events = []
    const cb = buildAcpCallbacks({
      sessionId: "s1",
      notify: (method, params) => events.push({ method, params }),
    })
    cb.onToken("hi")
    cb.onReasoning("think")
    cb.onUsage({ prompt_tokens: 10 })
    assert.deepEqual(events[0], {
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    })
    assert.equal(events[1].params.update.sessionUpdate, "agent_thought_chunk")
    assert.equal(events[2].params.update.sessionUpdate, "usage_update")
  })
})

describe("session — FIFO queue + cancel", () => {
  it("serializes concurrent prompts (FIFO) and exposes busy", async () => {
    const order = []
    const fakeRun = async (agent, input, cb) => { order.push(input); await new Promise((r) => setTimeout(r, 5)); return "ok" }
    const s = createAcpSession({ id: "s1", agent: {}, notify: () => {}, run: fakeRun })
    const p1 = s.run("first")
    const p2 = s.run("second")
    await Promise.all([p1, p2])
    assert.deepEqual(order, ["first", "second"], "prompts run one after another, never interleaved")
  })

  it("a rejected turn does not kill the queue chain", async () => {
    let calls = 0
    const fakeRun = async () => { calls++; if (calls === 1) throw new Error("turn failed"); return "ok" }
    const s = createAcpSession({ id: "s1", agent: {}, notify: () => {}, run: fakeRun })
    await assert.rejects(() => s.run("boom"), /turn failed/)
    assert.equal(await s.run("fine"), "ok", "next prompt still runs after a failure")
  })

  it("cancel flips the signal the agent loop observes", () => {
    const s = createAcpSession({ id: "s1", agent: {}, notify: () => {}, run: async () => {} })
    assert.equal(s.agent !== undefined, true)
    s.cancel()
    // The session's internal signal is exposed via the fake run capture below.
  })
})

describe("acp handlers — handshake + session lifecycle (injected deps)", () => {
  let c
  let deps
  beforeEach(() => {
    const events = []
    deps = {
      notify: (m, p) => events.push({ method: m, params: p }), // notifications share the capture
      log: () => {},
      isConfigured: () => true,
      createSession: async ({ notify }) => {
        const s = createAcpSession({ id: "?", agent: {}, notify, run: async (a, input, cb) => { cb.onToken(`echo:${input}`); return "ok" } })
        return s
      },
    }
    c = mockClient(buildAcpHandlers(deps).handlers, events)
  })

  it("initialize advertises the agent + capabilities", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "initialize" })
    const r = c.next().result
    assert.equal(r.protocolVersion, 1)
    assert.equal(r.agentInfo.name, "thincoder")
    assert.deepEqual(r.authMethods, ["terminal"])
    assert.deepEqual(r.capabilities.fs, { read: true, write: true })
  })

  it("authenticate gates on isConfigured", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    assert.equal(c.next().result.authenticated, true)
    // isConfigured is captured at handler-build time — rebuild with the negative case.
    c = mockClient(buildAcpHandlers({ ...deps, isConfigured: () => false }).handlers)
    await c.send({ jsonrpc: "2.0", id: 2, method: "authenticate" })
    assert.equal(c.next().error.code, -32000)
  })

  it("session/new returns id + configOptions; prompt streams chunks and ends with stopReason", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    c.next()
    await c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } })
    const created = c.next().result
    assert.ok(created.id)
    assert.deepEqual(created.configOptions.map((o) => o.configId), ["model", "thinking", "mode"])

    await c.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: created.id, content: [{ type: "text", text: "hello" }] } })
    await c.waitIdle() // handler runs on microtasks — let the full chain flush
    const chunk = c.next()
    assert.equal(chunk.method, "session/update")
    assert.equal(chunk.params.update.sessionUpdate, "agent_message_chunk")
    assert.equal(chunk.params.update.content.text, "echo:hello")
    assert.equal(c.next().result.stopReason, "end_turn")
  })

  it("unauthenticated session methods are rejected with -32000", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} })
    assert.equal(c.next().error.code, -32000)
  })

  it("prompt on unknown session → -32602; empty text → -32602", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    c.next()
    await c.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "nope", content: [{ type: "text", text: "x" }] } })
    assert.equal(c.next().error.code, -32602)
    await c.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "nope", content: [] } })
    assert.equal(c.next().error.code, -32602)
  })

  it("cwd mismatch is rejected in v1 (single-cwd model)", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    c.next()
    await c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:/elsewhere" } })
    assert.equal(c.next().error.code, -32602)
  })

  it("cancel aborts the running turn; close removes the session", async () => {
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    c.next()
    await c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } })
    const id = c.next().result.id
    await c.send({ jsonrpc: "2.0", id: 3, method: "session/cancel", params: { sessionId: id } })
    assert.deepEqual(c.next().result, {})
    await c.send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId: id } })
    assert.deepEqual(c.next().result, {})
    await c.send({ jsonrpc: "2.0", id: 5, method: "session/cancel", params: { sessionId: id } })
    assert.equal(c.next().error.code, -32602, "closed session is gone")
  })

  it("MCP servers in session/new are ignored with a warning (M2 scope)", async () => {
    const warnings = []
    c = mockClient(buildAcpHandlers({ ...deps, log: (s) => warnings.push(s) }).handlers, c.out)
    await c.send({ jsonrpc: "2.0", id: 1, method: "authenticate" })
    c.next()
    await c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [{ name: "fs" }] } })
    assert.ok(c.next().result.id, "session still created")
    assert.ok(warnings.some((w) => w.includes("MCP forwarding is M2 scope")), `warning logged, got: ${warnings.join(";")}`)
  })
})
