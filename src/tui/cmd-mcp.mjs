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
        // Pick transport type first, then ask name + URL/command
        openPicker({
          title: "MCP Transport",
          entries: [
            { type: "header", text: "Select transport or use AI assist" },
            { type: "item", text: "🤖 Describe with AI — natural language → config", action: "ai" },
            { type: "item", text: "HTTP (https://…)", action: "http" },
            { type: "item", text: "WebSocket (ws://…)", action: "ws" },
            { type: "item", text: "stdio (local command)", action: "stdio" },
          ],
          onSelect: async (te) => {
            if (te.action === "ai") {
              const description = await askQuestion("Describe the MCP server you want to add (e.g. 'a filesystem server that gives access to /tmp'):")
              if (!description) return
              pushLine("[mcp] Generating config from description...", C.dim)
              try {
                const { chat } = await import("../provider/index.mjs")
                const res = await chat(agent.provider, {
                  messages: [{
                    role: "user",
                    content: `Generate an MCP server configuration JSON from this description. Return ONLY the JSON object, no explanation.

Description: "${description}"

The JSON should have these fields:
- name: a short identifier
- One of: url (HTTP), wsUrl (WebSocket), or command + args (stdio)
- headers: optional key-value object

Example HTTP: {"name":"filesystem","url":"https://example.com/mcp","headers":{"Authorization":"Bearer xxx"}}
Example stdio: {"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}

Return ONLY the JSON object:`,
                  }],
                  tools: [],
                  signal: AbortSignal.timeout(15_000),
                })
                const jsonMatch = (res.content ?? "").match(/\{[\s\S]*\}/)
                if (!jsonMatch) { pushLine("[mcp] AI response not valid JSON", C.error); return }
                const srv = JSON.parse(jsonMatch[0])
                if (!srv.name) { pushLine("[mcp] AI response missing 'name' field", C.error); return }
                // Show preview and confirm
                pushLine(`[mcp] Generated config: ${JSON.stringify(srv)}`, C.tool)
                const confirm = await askQuestion("Add this server? (y/n):")
                if (confirm?.toLowerCase() !== "y") { pushLine("[mcp] Cancelled", C.dim); return }
                await addAndConnect(ctx, srv)
              } catch (err) {
                pushLine(`[mcp] AI generation failed: ${err.message}`, C.error)
              }
              return
            }
            const name = await askQuestion("Server name:")
            if (!name) return
            const existing = (agent.config?.mcp?.servers ?? []).find((s) => s.name === name)
            if (existing) { pushLine(`[mcp] "${name}" already exists`, C.error); return }
            if (te.action === "stdio") {
              const cmd = await askQuestion("Command (e.g. npx, python):")
              if (!cmd) return
              const argsInput = await askQuestion("Arguments (space-separated, or leave empty):")
              const args = argsInput ? argsInput.split(/\s+/) : undefined
              await addAndConnect(ctx, { name, command: cmd, args })
            } else {
              const urlPrompt = te.action === "ws" ? "WebSocket URL (ws://…):" : "HTTP URL (https://…):"
              const url = await askQuestion(urlPrompt)
              if (!url) return
              const headersInput = await askQuestion("Headers (key=value, space-separated, or leave empty):")
              const headers = headersInput ? parseHeaders(headersInput.split(/\s+/)) : undefined
              const srv = te.action === "ws"
                ? { name, wsUrl: url, headers: Object.keys(headers ?? {}).length > 0 ? headers : undefined }
                : { name, url, headers: Object.keys(headers ?? {}).length > 0 ? headers : undefined }
              await addAndConnect(ctx, srv)
            }
          },
        })
      }
    },
  })
}
