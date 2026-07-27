import { ansi, C } from "./ansi.mjs"

/** /mcp command handler: view/add/remove/reconnect MCP server.
 *  Extracted from slash-commands.mjs, includes /mcp-specific parseHeaders / addAndConnect helpers.
 *  ctx: { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw, ansi, C } */

function parseHeaders(pairs) {
  const headers = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, "")
  }
  return headers
}

/** /mcp shared helper: save config + connect (persistRaw obtained from ctx) */
async function addAndConnect(ctx, srv) {
  const { agent, pushLine, pushLabel, persistRaw } = ctx
  await persistRaw((raw) => {
    raw.mcp ??= { servers: [] }
    const entry = { name: srv.name }
    if (srv.url) { entry.url = srv.url; if (srv.headers) entry.headers = srv.headers }
    else if (srv.wsUrl) { entry.wsUrl = srv.wsUrl; if (srv.headers) entry.headers = srv.headers }
    else { entry.command = srv.command; if (srv.args) entry.args = srv.args }
    raw.mcp.servers.push(entry)
  })
  agent.config ??= {}
  agent.config.mcp ??= { servers: [] }
  agent.config.mcp.servers.push(srv)
  try {
    pushLine(`[mcp] Connecting ${srv.name}...`, C.dim)
    const { connectMcpServer } = await import("../mcp.mjs")
    const tools = await connectMcpServer(srv)
    agent.tools.push(...tools)
    pushLabel(`❯ MCP`, ansi.bold + C.tool)
    const desc = srv.wsUrl ? srv.wsUrl : srv.url ? srv.url : `${srv.command} ${(srv.args ?? []).join(" ")}`
    pushLine(`${srv.name} (${desc}) connected, ${tools.length} tools:`, C.tool)
    for (const t of tools) pushLine(`  ${t.name}: ${t.description.slice(0, 100)}`, C.dim)
  } catch (error) {
    pushLine(`[mcp] ${srv.name}: ${error.message} (config saved, retry after restart)`, C.error)
  }
}

export async function handleMcpCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, askQuestion, persistRaw } = ctx
  const servers = agent.config?.mcp?.servers ?? []
  const entries = [
    { type: "header", text: `${servers.length} MCP servers configured` },
    { type: "item", text: "View list", action: "list" },
    { type: "item", text: "Add server", action: "add" },
  ]
  if (servers.length > 0) {
    entries.push(
      { type: "item", text: "Remove server", action: "remove" },
      { type: "item", text: "Reconnect server", action: "connect" },
    )
  }
  openPicker({
    title: "MCP",
    entries,
    onSelect: async (e) => {
      if (e.action === "list") {
        pushLabel(`❯ MCP Servers`, ansi.bold + C.tool)
        if (servers.length === 0) {
          pushLine(" (no MCP server configured)", C.dim)
        }
        for (const srv of servers) {
          const connected = agent.tools.some((t) => t._mcpName === srv.name)
          const mark = connected ? "●" : "○"
          const color = connected ? C.tool : C.dim
          const toolCount = agent.tools.filter((t) => t._mcpName === srv.name).length
          const desc = srv.wsUrl ? srv.wsUrl : srv.url ? srv.url : `${srv.command} ${(srv.args ?? []).join(" ")}`
          pushLine(`  ${mark} ${srv.name} (${desc})${connected ? ` — ${toolCount} tools` : ""}`, color)
        }
        return
      }
      if (e.action === "remove") {
        const removeEntries = [
          { type: "header", text: "Select server to remove" },
          ...servers.map((s) => ({ type: "item", text: `${s.name} (${s.wsUrl ?? s.url ?? s.command})`, name: s.name })),
        ]
        openPicker({
          title: "Remove MCP Server",
          entries: removeEntries,
          onSelect: async (se) => {
            // Remove from config
            agent.config.mcp.servers = servers.filter((s) => s.name !== se.name)
            await persistRaw((raw) => { raw.mcp.servers = agent.config.mcp.servers })
            // Remove from tool list
            const { removeMcpTools } = await import("../mcp.mjs")
            removeMcpTools(agent, se.name)
            pushLine(`[mcp] ${se.name} removed`, C.tool)
          },
        })
        return
      }
      if (e.action === "connect") {
        const connectEntries = [
          { type: "header", text: "Select server to reconnect" },
          ...servers.map((s) => ({ type: "item", text: `${s.name} (${s.wsUrl ?? s.url ?? s.command})`, name: s.name })),
        ]
        openPicker({
          title: "Reconnect MCP",
          entries: connectEntries,
          onSelect: async (se) => {
            const srv = servers.find((s) => s.name === se.name)
            const { removeMcpTools, connectMcpServer } = await import("../mcp.mjs")
            removeMcpTools(agent, se.name)
            try {
              pushLine(`[mcp] Reconnecting ${se.name}...`, C.dim)
              const tools = await connectMcpServer(srv)
              agent.tools.push(...tools)
              pushLabel(`❯ MCP`, ansi.bold + C.tool)
              pushLine(`${se.name} reconnected, ${tools.length} tools available.`, C.tool)
            } catch (error) {
              pushLine(`[mcp] ${se.name}: ${error.message}`, C.error)
            }
          },
        })
        return
      }
      if (e.action === "add") {
        const mcpInput = await askQuestion("Enter: <name> <URL|command> [args...]\nURL auto-detect: https://… → HTTP, ws://… → WebSocket, other → stdio command")
        if (!mcpInput) return
        const parts = mcpInput.split(/\s+/)
        if (parts.length < 2) { pushLine("Usage: <name> <URL|command> [args...]", C.error); return }
        const [name, second, ...extras] = parts
        const existing = (agent.config?.mcp?.servers ?? []).find((s) => s.name === name)
        if (existing) { pushLine(`[mcp] "${name}" already exists`, C.error); return }
        const isWS = /^wss?:\/\//.test(second)
        const isHTTP = /^https?:\/\//.test(second)
        let srv
        if (isWS) {
          const headers = parseHeaders(extras)
          srv = { name, wsUrl: second, headers: Object.keys(headers).length > 0 ? headers : undefined }
        } else if (isHTTP) {
          const headers = parseHeaders(extras)
          srv = { name, url: second, headers: Object.keys(headers).length > 0 ? headers : undefined }
        } else {
          srv = { name, command: second, args: extras.length > 0 ? extras : undefined }
        }
        await addAndConnect(ctx, srv)
      }
    },
  })
}
