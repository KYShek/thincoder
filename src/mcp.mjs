/**
 * mcp.mjs — MCP (Model Context Protocol) client
 * config: { command, args?, name } 或 { url, name, headers? } 或 { wsUrl, name, headers? }
 */
import { INIT_TIMEOUT_MS, withTimeout, sanitizeToolName } from "./mcp/helpers.mjs"
import { stdioTransport } from "./mcp/transport-stdio.mjs"
import { httpTransport } from "./mcp/transport-http.mjs"
import { wsTransport } from "./mcp/transport-ws.mjs"

// ---- MCP lifecycle ----

function buildTools(mcpTools, transport, config) {
  const prefix = config.name ? `${config.name}_` : "mcp_"
  return mcpTools.map((t) => ({
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
