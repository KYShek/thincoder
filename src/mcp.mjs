/**
 * mcp.mjs — MCP (Model Context Protocol) client
 * 零依赖：stdio transport (spawn + JSON-RPC) + HTTP transport (fetch + SSE)。
 * config: { command, args?, name } 或 { url, name, headers? }
 */

import { spawn } from "node:child_process"

const INIT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000

// ---- JSON-RPC helpers ----

let nextRpcId = 0
function rpcId() {
  return String(++nextRpcId) // 自增：随机数可能碰撞串响应
}

// ---- stdio transport ----

function stdioTransport(command, args) {
  // Windows 上 npx 等命令是 .cmd，Node 不带 shell 拒 spawn（EINVAL）；
  // shell:true 又触发 DEP0190 且不转义参数——显式走 cmd.exe 并自己加引号；
  // windowsVerbatimArguments 防止 Node 把内层引号转义成 \"（cmd 不认，会把引号当字面量传下去）
  const spawnOptions = { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env } }
  const child =
    process.platform === "win32" && !/\.exe$/i.test(command)
      ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...(args ?? [])].map(quoteArg).join(" ")], {
          ...spawnOptions,
          windowsVerbatimArguments: true,
        })
      : spawn(command, args ?? [], spawnOptions)

  const pending = new Map()
  let buffer = ""
  let stderrTail = "" // 诊断用：server 起不来时给用户一点线索
  let spawnError = null
  let closed = false

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  child.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const resolver = pending.get(msg.id)
        if (resolver) {
          pending.delete(msg.id)
          resolver(msg)
        }
      } catch {
        // 非 JSON 行忽略
      }
    }
  })

  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  // spawn 失败（命令不存在/EINVAL）：没有这个监听，error 事件会崩掉整个进程
  child.on("error", (error) => {
    spawnError = error
    closed = true
    failAll(`spawn failed: ${error.message}`)
  })

  child.on("close", () => {
    closed = true
    const lastLine = stderrTail.trim().split("\n").pop()
    failAll(`Connection closed${lastLine ? ` | stderr: ${lastLine}` : ""}`)
  })

  const send = (method, params) => {
    if (spawnError) return Promise.resolve({ id: null, error: { code: -32000, message: `spawn failed: ${spawnError.message}` } })
    if (closed) return Promise.reject(new Error("MCP connection closed"))
    const id = rpcId()
    const promise = new Promise((resolve) => pending.set(id, resolve))
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    return withTimeout(promise, CALL_TIMEOUT_MS).finally(() => pending.delete(id))
  }

  // notification：无 id，不期待响应（协议要求）
  const notify = (method, params) => {
    if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  return { send, notify, close: () => { if (!closed) child.kill() } }
}

// ---- HTTP + SSE transport (Streamable HTTP) ----

function httpTransport(baseURL, extraHeaders = {}) {
  const url = baseURL.replace(/\/+$/, "")
  let sessionId = null
  let closed = false
  let eventSource = null
  let abortController = null

  const headers = () => {
    const h = { "Content-Type": "application/json", Accept: "text/event-stream, application/json", ...extraHeaders }
    if (sessionId) h["Mcp-Session-Id"] = sessionId
    return h
  }

  const pending = new Map()

  // SSE 解析器：从 response body 逐行读，处理 data: / event: / id: / 空行(dispatch)
  async function* parseSSE(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let current = { data: "", event: "message" }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
          if (line === "") {
            if (current.data) {
              yield { event: current.event, data: current.data.trimEnd() }
              current = { data: "", event: "message" }
            }
          } else if (line.startsWith("data:")) {
            current.data += (current.data ? "\n" : "") + line.slice(5).replace(/^ /, "")
          } else if (line.startsWith("event:")) {
            current.event = line.slice(6).trim()
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // 打开 SSE 长连接（用于接收服务端推送）
  async function openSSE() {
    if (closed) return
    abortController?.abort()
    abortController = new AbortController()
    const resp = await fetch(url + "/sse", {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: abortController.signal,
    })
    if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`)
    eventSource = parseSSE(resp)

    // 后台消费 SSE 事件并分发到 pending
    ;(async () => {
      try {
        for await (const { data } of eventSource) {
          if (closed) break
          try {
            const msg = JSON.parse(data)
            const resolver = pending.get(msg.id)
            if (resolver) {
              pending.delete(msg.id)
              resolver(msg)
            }
            // 没有 pending resolver 的可能是通知，忽略
          } catch { /* 非 JSON，忽略 */ }
        }
      } catch (error) {
        if (!closed) {
          for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message: `SSE error: ${error.message}` } })
        }
      }
    })()
  }

  // POST JSON-RPC 请求，同时监听响应
  async function postRequest(method, params) {
    const id = rpcId()
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })

    // 如果有活跃的 SSE 连接，服务器会通过 SSE 推回响应
    if (eventSource) {
      return new Promise((resolve) => {
        pending.set(id, resolve)
        fetch(url + "/messages", { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
          .catch((e) => {
            pending.delete(id)
            resolve({ id, error: { code: -32000, message: `POST failed: ${e.message}` } })
          })
      })
    }

    // 没有 SSE：纯 HTTP POST，响应就是 JSON-RPC
    const resp = await fetch(url + "/messages", {
      method: "POST",
      headers: headers(),
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

    const ct = resp.headers.get("content-type") ?? ""
    const newSessionId = resp.headers.get("Mcp-Session-Id")
    if (newSessionId) sessionId = newSessionId

    if (ct.includes("text/event-stream")) {
      // 服务器返回 SSE：第一个事件是响应
      const sse = parseSSE(resp)
      for await (const { data } of sse) {
        try {
          const msg = JSON.parse(data)
          if (msg.id === id) return msg
          // 可能是通知
        } catch { /* skip */ }
      }
      return { id, error: { code: -32000, message: "No JSON-RPC response in SSE stream" } }
    }

    // 纯 JSON 响应
    return resp.json()
  }

  const send = async (method, params) => withTimeout(postRequest(method, params), CALL_TIMEOUT_MS)

  // notification：无 id，不期待响应（协议要求）
  const notify = (method, params) => {
    fetch(url + "/messages", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  const close = () => {
    closed = true
    abortController?.abort()
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message: "Connection closed" } })
    pending.clear()
  }

  return { send, notify, close, openSSE, url, headers: extraHeaders }
}

// ---- MCP lifecycle ----

function buildTools(mcpTools, transport, config) {
  const prefix = config.name ? `${config.name}_` : "mcp_"
  return mcpTools.map((t) => ({
    name: prefix + sanitizeToolName(t.name),
    description: t.description ?? `MCP tool: ${t.name}`,
    parameters: t.inputSchema ?? { type: "object", properties: {} },
    readonly: false,
    async execute(args) {
      const resp = await transport.send("tools/call", { name: t.name, arguments: args })
      if (resp.error) throw new Error(`MCP tool "${t.name}": ${resp.error.message}`)
      const content = resp.result?.content ?? []
      return content
        .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? `[resource: ${c.resource?.uri}]` : JSON.stringify(c)))
        .join("\n") || "(no output)"
    },
    _mcpTransport: transport,
    _mcpName: config.name,
  }))
}

async function doInitialize(transport, name) {
  const initResp = await withTimeout(
    transport.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "thincoder", version: "1.0.0" },
    }),
    INIT_TIMEOUT_MS,
  )
  if (initResp.error) throw new Error(`initialize error: ${initResp.error.message}`)
  transport.notify?.("notifications/initialized", {})

  const toolsResp = await transport.send("tools/list", {})
  if (toolsResp.error) throw new Error(`tools/list failed: ${toolsResp.error.message}`)
  return toolsResp.result?.tools ?? []
}

/**
 * 连接一个 MCP server。
 * stdio: { name, command, args? }
 * http:  { name, url, headers? }
 */
export async function connectMcpServer(config) {
  if (config.url) {
    const transport = httpTransport(config.url, config.headers ?? {})
    try {
      await transport.openSSE()
    } catch {
      // 不支持 GET /sse 的 server（纯 Streamable HTTP POST）：降级为无 SSE 模式
    }
    const mcpTools = await doInitialize(transport, config.name ?? config.url)
    return buildTools(mcpTools, transport, config)
  }

  if (config.command) {
    const transport = stdioTransport(config.command, config.args ?? [])
    try {
      const mcpTools = await doInitialize(transport, config.name ?? config.command)
      return buildTools(mcpTools, transport, config)
    } catch (error) {
      transport.close()
      throw error
    }
  }

  throw new Error(`MCP server "${config.name}": needs either 'command' (stdio) or 'url' (http)`)
}

export function closeAllMcp(agent) {
  for (const t of agent.tools) {
    if (t._mcpTransport) t._mcpTransport.close()
  }
}

export function removeMcpTools(agent, serverName) {
  const keep = []
  for (const t of agent.tools) {
    if (t._mcpName === serverName) {
      if (t._mcpTransport) t._mcpTransport.close()
    } else {
      keep.push(t)
    }
  }
  agent.tools = keep
}

// ---- helpers ----

function sanitizeToolName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

/** cmd.exe 参数加引号（含空格/引号时） */
function quoteArg(s) {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    timer.unref?.() // 不拖住进程退出
  })
  // 竞速结束后清掉定时器，不留垃圾
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}
