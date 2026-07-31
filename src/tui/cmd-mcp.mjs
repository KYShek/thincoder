import { ansi, C } from "./ansi.mjs"

/** /mcp command handler: view/add/remove/reconnect MCP server.
 *  Extracted from slash-commands.mjs, includes /mcp-specific parseHeaders / addAndConnect helpers.
 *  ctx: { agent, pushLine, pushLabel, showPicker, askQuestion, persistRaw, ansi, C } */

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
    else { entry.command = srv.command; if (srv.args) entry.args = srv.args; if (srv.env) entry.env = srv.env }
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

export async function handleMcpCommand(ctx, args = []) {
  const { agent, pushLine, pushLabel, showPicker, askQuestion, persistRaw } = ctx
  // 每轮重读：原本无 mcp 配置时 `?? []` 会拿到游离数组，Add server 后快照过期
  const getServers = () => agent.config?.mcp?.servers ?? []

  function listServers() {
    const servers = getServers()
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
  }

  async function removeServer(name) {
    agent.config.mcp.servers = getServers().filter((s) => s.name !== name)
    await persistRaw((raw) => { raw.mcp.servers = agent.config.mcp.servers })
    // Remove from tool list
    const { removeMcpTools } = await import("../mcp.mjs")
    removeMcpTools(agent, name)
    pushLine(`[mcp] ${name} removed`, C.tool)
  }

  async function connectServer(name) {
    const srv = getServers().find((s) => s.name === name)
    const { removeMcpTools, connectMcpServer } = await import("../mcp.mjs")
    removeMcpTools(agent, name)
    try {
      pushLine(`[mcp] Reconnecting ${name}...`, C.dim)
      const tools = await connectMcpServer(srv)
      agent.tools.push(...tools)
      pushLabel(`❯ MCP`, ansi.bold + C.tool)
      pushLine(`${name} reconnected, ${tools.length} tools available.`, C.tool)
    } catch (error) {
      pushLine(`[mcp] ${name}: ${error.message}`, C.error)
    }
  }

  async function addWithTransport(transport) {
    if (transport === "ai") {
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
    if (transport === "stdio") {
      const cmd = await askQuestion("Command (e.g. npx, python):")
      if (!cmd) return
      const argsInput = await askQuestion("Arguments (space-separated, or leave empty):")
      const cmdArgs = argsInput ? argsInput.split(/\s+/) : undefined
      const envInput = await askQuestion("Environment variables (KEY=value, space-separated, or leave empty):")
      const env = envInput ? parseHeaders(envInput.split(/\s+/)) : undefined
      await addAndConnect(ctx, { name, command: cmd, args: cmdArgs, env })
    } else {
      const urlPrompt = transport === "ws" ? "WebSocket URL (ws://…):" : "HTTP URL (https://…):"
      const url = await askQuestion(urlPrompt)
      if (!url) return
      const headersInput = await askQuestion("Headers (key=value, space-separated, or leave empty):")
      const headers = headersInput ? parseHeaders(headersInput.split(/\s+/)) : undefined
      const srv = transport === "ws"
        ? { name, wsUrl: url, headers: Object.keys(headers ?? {}).length > 0 ? headers : undefined }
        : { name, url, headers: Object.keys(headers ?? {}).length > 0 ? headers : undefined }
      await addAndConnect(ctx, srv)
    }
  }

  async function addFlow() {
    // Pick transport type first, then ask name + URL/command
    const te = await showPicker("MCP Transport", [
      { type: "header", text: "Select transport or use AI assist" },
      { type: "item", text: "🤖 Describe with AI — natural language → config", action: "ai" },
      { type: "item", text: "HTTP (https://…)", action: "http" },
      { type: "item", text: "WebSocket (ws://…)", action: "ws" },
      { type: "item", text: "stdio (local command)", action: "stdio" },
    ])
    if (te) await addWithTransport(te.action)
  }

  /** remove/connect 的服务器选择 picker + 执行。返回 true = 已执行；false = Esc 取消。 */
  async function pickAndRun(action) {
    const servers = getServers()
    if (servers.length === 0) {
      pushLine("[mcp] no MCP server configured", C.error)
      return true
    }
    const subEntries = [
      { type: "header", text: action === "remove" ? "Select server to remove" : "Select server to reconnect" },
      ...servers.map((s) => ({ type: "item", text: `${s.name} (${s.wsUrl ?? s.url ?? s.command})`, name: s.name })),
    ]
    const se = await showPicker(action === "remove" ? "Remove MCP Server" : "Reconnect MCP", subEntries)
    if (!se) return false // Esc 取消
    if (action === "remove") await removeServer(se.name)
    else await connectServer(se.name)
    return true
  }

  // Direct args: /mcp list │ /mcp add │ /mcp http|ws|stdio|ai │ /mcp remove [name] │ /mcp connect [name]
  const sub = args[0]?.toLowerCase()
  if (sub === "list") { listServers(); return }
  if (sub === "add") { await addFlow(); return }
  if (sub === "http" || sub === "ws" || sub === "stdio" || sub === "ai") { await addWithTransport(sub); return }
  if (sub === "remove" || sub === "connect") {
    const name = args[1]
    if (name) {
      const servers = getServers()
      if (!servers.some((s) => s.name === name)) {
        pushLine(`[mcp] no server named "${name}" (${servers.map((s) => s.name).join(", ") || "none configured"})`, C.error)
        return
      }
      if (sub === "remove") await removeServer(name)
      else await connectServer(name)
      return
    }
    // 已明确 remove/connect 意图但没带 name → 直接进服务器选择 picker，不落主菜单
    await pickAndRun(sub)
    return
  } else if (sub) {
    pushLine("Usage: /mcp [list|add|http|ws|stdio|ai|remove [name]|connect [name]]", C.error)
    return
  }

  // 主菜单循环：选中即关闭，子菜单 Esc 返回主菜单，主菜单 Esc 退出
  for (;;) {
    const servers = getServers()
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
    const e = await showPicker("MCP", entries)
    if (!e) return // Esc 退出
    if (e.action === "list") {
      listServers()
      return
    }
    if (e.action === "add") {
      await addFlow()
      continue
    }
    const done = await pickAndRun(e.action)
    if (!done) continue // 子菜单 Esc → 回主菜单
    return
  }
}
