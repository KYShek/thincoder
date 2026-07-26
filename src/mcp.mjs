/**
 * mcp.mjs — MCP (Model Context Protocol) client
 * 零依赖：stdio transport (spawn + JSON-RPC) + HTTP transport (fetch + SSE) + WebSocket transport (global WebSocket)。
 * config: { command, args?, name } 或 { url, name, headers? } 或 { wsUrl, name, headers? }
 */

import { spawn } from "node:child_process"

const INIT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000
// 等 legacy SSE 首个 endpoint 事件的上限：legacy server 连接后立即发，实际几毫秒内到达
const ENDPOINT_WAIT_MS = 5_000

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
  const decoder = new TextDecoder() // 单一实例：跨 chunk 保留多字节 UTF-8 的中间状态
  let buffer = ""
  let stderrTail = "" // 诊断用：server 起不来时给用户一点线索
  let spawnError = null
  let closed = false

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  child.stdout.on("data", (chunk) => {
    // stream:true：多字节字符跨 chunk 拆分时暂存残片，等下一个 chunk 拼完整
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
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

  // stdin 写错误（EPIPE 等）：没有这个监听，error 事件会崩掉整个进程；close 事件统一兜底
  child.stdin.on("error", () => {})

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
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    } catch (error) {
      pending.delete(id)
      return Promise.resolve({ id: null, error: { code: -32000, message: `stdin write failed: ${error.message}` } })
    }
    return withTimeout(promise, CALL_TIMEOUT_MS).finally(() => pending.delete(id))
  }

  // notification：无 id，不期待响应（协议要求）
  const notify = (method, params) => {
    if (closed) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    } catch { /* 忽略：close 事件会兜底 */ }
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
  // legacy SSE (2024-11-05)：POST 地址由 server 的 endpoint 事件告知；
  // Streamable HTTP (2025-03-26)：POST 到配置的 URL 本身
  let postUrl = url
  // 收到 endpoint 事件才置真：legacy SSE (2024-11-05) 模式，POST 只回 202，响应经 SSE 流推回；
  // 否则按 Streamable HTTP (2025-03-26)：响应就在 POST 自身（即使 server 同时支持 GET 推送）
  let legacySSE = false

  const headers = () => {
    const h = { "Content-Type": "application/json", Accept: "text/event-stream, application/json", ...extraHeaders }
    if (sessionId) h["Mcp-Session-Id"] = sessionId
    return h
  }

  const pending = new Map()

  // SSE 解析器：从 response body 逐行读，处理 data: / event: / 空行(dispatch)
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

  // 打开 SSE 长连接（legacy SSE transport，用于接收服务端推送）
  // 按 2024-11-05 规范：GET 配置的 URL 本身，server 的第一个 endpoint 事件告知 POST 地址
  async function openSSE() {
    if (closed) return
    abortController?.abort()
    abortController = new AbortController()
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream", ...extraHeaders },
      signal: abortController.signal,
    })
    if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`)
    eventSource = parseSSE(resp)
    let endpointReady
    const gotEndpoint = new Promise((resolve) => { endpointReady = resolve })

    // 后台消费 SSE 事件并分发到 pending
    ;(async () => {
      try {
        for await (const { event, data } of eventSource) {
          if (closed) break
          if (event === "endpoint") {
            // data 是相对/绝对 URI，拼到配置的 URL 上作为 POST 地址
            postUrl = new URL(data.trim(), url).href
            legacySSE = true
            endpointReady()
            continue
          }
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
          pending.clear()
        }
      }
    })()

    // 等 endpoint 事件再发请求（2024-11-05 要求拿到 POST 地址后才能 POST）；
    // 超时说明不是 legacy server——Streamable HTTP 的 GET 流只推服务端消息，响应走 POST 自身
    const wait = new Promise((resolve) => {
      const t = setTimeout(resolve, ENDPOINT_WAIT_MS)
      t.unref?.()
    })
    await Promise.race([gotEndpoint, wait])
  }

  // POST JSON-RPC 请求，同时监听响应
  async function postRequest(method, params) {
    const id = rpcId()
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })

    // legacy SSE：POST 只回 202，服务器经 SSE 流推回响应
    if (legacySSE) {
      return new Promise((resolve) => {
        pending.set(id, resolve)
        fetch(postUrl, { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
          .then((resp) => {
            // 2024-11-05：POST 期望 202 Accepted；其他错误码说明请求没送达
            if (!resp.ok) {
              pending.delete(id)
              resolve({ id, error: { code: -32000, message: `POST failed: HTTP ${resp.status}` } })
            }
          })
          .catch((e) => {
            pending.delete(id)
            resolve({ id, error: { code: -32000, message: `POST failed: ${e.message}` } })
          })
        // 兜底清理：响应超时（send 外层 withTimeout 先赢）时 pending 不留尸
      }).finally(() => pending.delete(id))
    }

    // Streamable HTTP（无 SSE，或 GET 流只推服务端消息）：响应就在 POST 自身
    const resp = await fetch(postUrl, {
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
    fetch(postUrl, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  const close = () => {
    closed = true
    abortController?.abort()
    // Streamable HTTP 规范：有 session 时发 DELETE 让 server 释放会话（尽力而为）
    if (sessionId) {
      fetch(postUrl, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId, ...extraHeaders },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
      sessionId = null
    }
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message: "Connection closed" } })
    pending.clear()
  }

  return { send, notify, close, openSSE, url, headers: extraHeaders }
}

// ---- WebSocket transport ----

function wsTransport(wsUrl, extraHeaders = {}) {
  const pending = new Map()
  let closed = false
  let ws = null

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  const connect = () => {
    if (closed) throw new Error("MCP WebSocket connection closed")
    // WebSocket API 不支持自定义 header，token 走 query param
    // （不能把 "Bearer ..." 当子协议传——含空格，违反 Sec-WebSocket-Protocol token 规则会抛 SyntaxError）
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
          // 没有 resolver 的是通知，忽略
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
      // 非 OPEN 状态 send 会同步抛；close 事件随后统一兜底
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

// ---- MCP lifecycle ----

function buildTools(mcpTools, transport, config) {
  const prefix = config.name ? `${config.name}_` : "mcp_"
  return mcpTools.map((t) => ({
    // 组合名整体 sanitize + 截断：prefix 也要计入 64 字符上限
    name: sanitizeToolName(prefix + t.name),
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
  if (config.wsUrl) {
    const transport = wsTransport(config.wsUrl, config.headers ?? {})
    try {
      await transport.connect()
      const mcpTools = await doInitialize(transport, config.name ?? config.wsUrl)
      return buildTools(mcpTools, transport, config)
    } catch (error) {
      transport.close()
      throw error
    }
  }

  if (config.url) {
    const transport = httpTransport(config.url, config.headers ?? {})
    try {
      await transport.openSSE()
    } catch {
      // 不支持 GET 的 server（纯 Streamable HTTP POST）：降级为无 SSE 模式
    }
    try {
      const mcpTools = await doInitialize(transport, config.name ?? config.url)
      return buildTools(mcpTools, transport, config)
    } catch (error) {
      transport.close()
      throw error
    }
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

  throw new Error(`MCP server "${config.name}": needs either 'wsUrl' (websocket), 'command' (stdio), or 'url' (http)`)
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

/** 把 Authorization header 转成 ?token= query param（WebSocket 无法自定义 header） */
function withAuthToken(wsUrl, authorization) {
  if (!authorization) return wsUrl
  const token = authorization.replace(/^Bearer\s+/i, "")
  const u = new URL(wsUrl)
  u.searchParams.set("token", token)
  return u.href
}

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
