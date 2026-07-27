/**
 * slash-commands.mjs — 斜杠命令处理
 * 从 index.mjs 抽出：SLASH_COMMANDS 定义、handleSlash 分发、Tab 补全、
 * 以及 handleSlash 专用的 helper (persistRaw / syncProviderField / maskKey /
 * parseHeaders / addAndConnect)。
 *
 * 通过 ctx 对象访问 startTUI 闭包中的共享状态与 UI 函数，避免循环依赖。
 * ctx: { agent, state, distillOpts, pushLine, pushLabel, render,
 *        openPicker, askQuestion, askPermission, openModelPicker,
 *        setProviderKey, runDistill }
 */

import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"
import { clearSession, listSlots, switchToSlot, applySession } from "../session.mjs"
import { PROVIDER_PRESETS as PRESETS } from "../config.mjs"
import { ansi, C } from "./ansi.mjs"

export const SLASH_COMMANDS = [
  { name: "/plan", group: "Agent", desc: "toggle plan mode (design first, then implement)" },
  { name: "/auto", group: "Agent", desc: "toggle auto-approve" },
  { name: "/model", group: "Agent", desc: "select model" },
  { name: "/goal", group: "Agent", desc: "set/view/cancel long-term goal" },
  { name: "/think", group: "Agent", desc: "thinking mode & reasoning effort" },
  { name: "/init", group: "Tools", desc: "generate project AGENTS.md skeleton" },
  { name: "/skills", group: "Tools", desc: "list project skills" },
  { name: "/mcp", group: "Tools", desc: "manage MCP servers" },
  { name: "/provider", group: "Config", desc: "manage providers (add/remove/set key)" },
  { name: "/config", group: "Config", desc: "config management (embedding / agent)" },
  { name: "/reindex", group: "Config", desc: "rebuild memory index" },
  { name: "/new", group: "Session", desc: "new session (old one archived to slot)" },
  { name: "/session", group: "Session", desc: "list/switch archived sessions" },
  { name: "/clear", group: "Session", desc: "clear screen" },
  { name: "/extract", group: "Session", desc: "extract knowledge from session" },
  { name: "/restore", group: "Session", desc: "restore checkpoint" },
  { name: "/exit", group: "Session", desc: "exit" },
  { name: "/help", group: "", desc: "this list" },
]

function parseHeaders(pairs) {
  const headers = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, "")
  }
  return headers
}

/** /mcp 共享 helper: 保存 Config + Connecting (persistRaw 从 ctx 获取) */
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

/**
 * 创建斜杠命令处理器。
 * 返回 { handleSlash, completions, handleTab }。
 */
export function createSlashCommands(ctx) {
  const { agent, state, distillOpts, pushLine, pushLabel, render } = ctx
  const openPicker = ctx.openPicker
  const askQuestion = ctx.askQuestion
  const askPermission = ctx.askPermission
  const persistRaw = ctx.persistRaw
  const syncProviderField = (field, value) => ctx.syncProviderField(field, value)
  const maskKey = ctx.maskKey

  async function handleSlash(text) {
    const [cmd, ...rest] = text.split(/\s+/)
    // 高频命令缩写
    const aliases = { "/h": "/help", "/x": "/exit", "/m": "/model", "/p": "/plan", "/t": "/think", "/c": "/clear", "/n": "/new" }
    const resolved = aliases[cmd] ?? cmd
    switch (resolved) {
      case "/clear":
        // 二次确认防误触（对话区内容不可恢复）
        if (state.lines.length > 0) {
          openPicker({
            title: "Clear screen?",
            entries: [
              { type: "item", text: "Yes, clear all conversation output", action: "yes" },
              { type: "item", text: "Cancel", action: "no" },
            ],
            defaultIndex: 1,
            onSelect: (e) => {
              if (e.action === "yes") {
                state.lines = []
                state.streaming = ""
                render()
              }
            },
          })
          return
        }
        state.lines = []
        state.streaming = ""
        render()
        return
      case "/new":
        agent.history = []
        agent.tasks = []
        agent.planMode = false
        agent.goal = null
        agent._pendingReminders = []
        state.tasks = []
        state.lines = []
        state.streaming = ""
        clearSession(agent.cwd)
        pushLine("New session started (old session archived to slot; /session to view)", C.dim)
        return
      case "/exit":
        ctx.exit()
        return
      case "/session": {
        const slots = listSlots(agent.cwd)
        if (slots.length === 0) {
          pushLine("No archived sessions (use /new and old sessions auto-archive to slots)", C.dim)
        } else {
          const entries = [
            { type: "header", text: `Archived sessions (↑↓ select, Enter switch, Esc cancel)` },
            ...slots.map((s) => ({
              type: "item",
              text: `Slot ${s.slot} — ${s.date}`,
              slot: s.slot,
            })),
          ]
          openPicker({
            title: "Sessions",
            entries,
            onSelect: (e) => {
              const data = switchToSlot(agent.cwd, e.slot)
              if (!data) {
                pushLine(`Slot ${e.slot} not found`, C.dim)
                return
              }
              applySession(agent, data)
              state.lines = data.display.length
                ? data.display.map((l) => ({ text: l.text, color: l.color }))
                : []
              state.tasks = agent.tasks ?? []
              if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
                state.tasks = []
              }
              pushLabel(`── Switched to slot ${e.slot} (${data.history.length} messages) ──`, C.warn)
              render()
            },
          })
        }
        return
      }
      case "/reindex": {
        const { syncDir, codeSync, docSync } = await import("../memory.mjs")
        pushLine("[reindex] Rebuilding index...", C.tool)
        agent.memory.db.prepare("DELETE FROM files").run()
        agent.memory.db.prepare("DELETE FROM code_chunks").run()
        agent.memory.db.prepare("DELETE FROM doc_chunks").run()
        let total = 0
        if (distillOpts.projectDir) {
          const s = await syncDir(agent.memory, { layer: "project", dir: distillOpts.projectDir })
          total += s.added
          pushLine(`  project: +${s.added} ~${s.updated} -${s.removed}`, C.dim)
        }
        if (distillOpts.team?.dir) {
          const s = await syncDir(agent.memory, { layer: "team", dir: distillOpts.team.dir })
          total += s.added
          pushLine(`  team: +${s.added} ~${s.updated} -${s.removed}`, C.dim)
        }
        // 重建代码索引和文档索引并行（读写不同表，WAL 支持）
        pushLine(`  [code+doc] Rebuilding indexes...`, C.tool)
        const [cr, dr] = await Promise.all([
          codeSync(agent.memory, agent.cwd, {
            onProgress: (p) => {
              if (p.phase === "index" && p.current % 20 === 0) {
                pushLine(`    code: ${p.current}/${p.total}`, C.dim)
              }
            },
          }),
          docSync(agent.memory, agent.cwd, {
            onProgress: (p) => {
              if (p.phase === "index" && p.current % 5 === 0) {
                pushLine(`    doc: ${p.current}/${p.total}`, C.dim)
              }
            },
          }),
        ])
        pushLine(`  code: ${cr.total} files, +${cr.updated} ~${cr.skipped} -${cr.removed}`, C.dim)
        pushLine(`  doc: ${dr.total} files, +${dr.updated} ~${dr.skipped} -${dr.removed}`, C.dim)
        pushLine(`[reindex] Done, ${total} entries total. Vectors will be lazily generated on next search.`, C.tool)
        return
      }
      case "/init": {
        const { writeFile, readFile } = await import("node:fs/promises")
        const { join } = await import("node:path")
        const agPath = join(agent.cwd, "AGENTS.md")
        if (existsSync(agPath)) {
          pushLine(`AGENTS.md already exists: ${agPath}`, C.warn)
          return
        }

        // 探测项目类型与关键信息
        let name = basename(agent.cwd)
        let lang = "", cmds = ""

        // Node.js
        try {
          const pkg = JSON.parse(await readFile(join(agent.cwd, "package.json"), "utf8"))
          if (pkg.name) name = pkg.name
          lang = "Node.js"
          const ks = Object.keys(pkg.scripts ?? {})
          if (ks.length) cmds = ks.slice(0, 5).map(k => `- \`npm run ${k}\``).join("\n")
        } catch {}

        // Python
        if (!lang) {
          for (const f of ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg"]) {
            if (existsSync(join(agent.cwd, f))) { lang = "Python"; break }
          }
          if (lang) cmds = "- `pip install -r requirements.txt`\n- `python -m pytest`"
        }

        // Go
        if (!lang) {
          if (existsSync(join(agent.cwd, "go.mod"))) {
            lang = "Go"
            cmds = "- `go build ./...`\n- `go test ./...`"
          }
        }

        // Rust
        if (!lang) {
          if (existsSync(join(agent.cwd, "Cargo.toml"))) {
            lang = "Rust"
            cmds = "- `cargo build`\n- `cargo test`"
          }
        }

        // Java / Kotlin
        if (!lang) {
          if (existsSync(join(agent.cwd, "pom.xml"))) { lang = "Java (Maven)"; cmds = "- `mvn test`" }
          else if (existsSync(join(agent.cwd, "build.gradle")) || existsSync(join(agent.cwd, "build.gradle.kts"))) { lang = "Java/Kotlin (Gradle)"; cmds = "- `./gradlew test`" }
        }

        const lines = [
          `# AGENTS.md — ${name} Project Guide`,
          ``,
          `## Project Overview`,
          ``,
          `Brief description of what this project does.`,
          ``,
          `## Tech Stack`,
          ``,
          lang ? `- Language: ${lang}` : `- Language: (detect and fill in)`,
          `- Framework: (fill in if applicable)`,
          ``,
          `## Common Commands`,
          ``,
          cmds || `- (fill in build/test/run commands)`,
          ``,
          `## Coding Conventions`,
          ``,
          `- (fill in: naming, formatting, testing patterns)`,
          ``,
          `## Architecture Notes`,
          ``,
          `- (fill in: key modules, data flow, design decisions)`,
        ]

        const template = lines.join("\n")
        await writeFile(agPath, template, "utf8")
        pushLabel(`❯ Init`, ansi.bold + C.tool)
        pushLine(`Generated AGENTS.md → ${agPath}${lang ? ` (${lang})` : ""}`, C.tool)
        if (lang) pushLine("Tell me more about the project and I will fill in conventions and structure", C.dim)
        return
      }
      case "/restore": {
        const { listCheckpoints, rewind, isGitRepo } = await import("../git/checkpoint.mjs")
        if (!isGitRepo(agent.cwd)) {
          pushLine("[rewind] not a git repository, checkpoints unavailable", C.error)
          return
        }
        const cps = await listCheckpoints(agent.cwd)
        if (cps.length === 0) {
          pushLine("(no checkpoints — created automatically before each task)", C.dim)
          return
        }
        const entries = [
          { type: "header", text: "Checkpoints (↑↓ select, Enter restore, Esc cancel)" },
          ...cps.slice(0, 12).map((cp) => ({
            type: "item",
            text: `${cp.id}  ${new Date(cp.time).toLocaleString()}  (+${cp.untracked} untracked files)`,
            id: cp.id,
          })),
        ]
        openPicker({
          title: "Restore Checkpoint",
          entries,
          onSelect: async (e) => {
            try {
              const summary = await rewind(agent.cwd, e.id)
              pushLabel(`❯ Rewind`, ansi.bold + C.warn)
              pushLine(`Restored to ${e.id}: patch ${summary.patchApplied ? "applied" : "none"}, deleted ${summary.deleted} new files, restored ${summary.restored} file(s)`, C.tool)
              pushLine("(current state saved as new checkpoint; /restore again to go back)", C.dim)
            } catch (error) {
              pushLine(`[rewind] ${error.message}`, C.error)
            }
          },
        })
        return
      }
      case "/plan": {
        agent.planMode = !agent.planMode
        agent._pendingReminders = agent._pendingReminders ?? []
        if (agent.planMode) {
          agent._pendingReminders.push("[System reminder: plan mode is now ON. You are restricted to READ-ONLY tools — explore, search, read, analyze. DO NOT write, edit, or run mutation commands. Present your design to the user first.]")
        } else {
          agent._pendingReminders.push("[System reminder: plan mode is now OFF. You may edit files, run commands, and implement changes.]")
        }
        pushLabel(`❯ Plan`, ansi.bold + (agent.planMode ? C.tool : C.dim))
        pushLine(
          agent.planMode
            ? `Plan mode ON: read-only tools only. Design first, then implement. /plan again to exit.`
            : `Plan mode OFF: you may now edit files and run commands.`,
          agent.planMode ? C.tool : C.dim,
        )
        return
      }
      case "/goal": {
        const entries = [
          { type: "header", text: agent.goal ? `Current goal: ${agent.goal.objective.slice(0, 60)}` : "Actions" },
          { type: "item", text: "Set new goal", action: "set" },
        ]
        if (agent.goal) {
          entries.push({ type: "item", text: "Cancel goal", action: "cancel" })
          entries.push({ type: "item", text: "View details", action: "view" })
        }
        openPicker({
          title: "Goal",
          entries,
          onSelect: async (e) => {
            if (e.action === "view") {
              const statusText = { active: "active", complete: "completed", blocked: "blocked" }[agent.goal.status] ?? agent.goal.status
              pushLabel(`❯ Goal`, ansi.bold + C.warn)
              pushLine(`Goal: ${agent.goal.objective}`, C.tool)
              if (agent.goal.criteria) pushLine(`  Criteria: ${agent.goal.criteria}`, C.dim)
              pushLine(`  Status: ${statusText} │ Turns used: ${agent.goal.turnsUsed ?? 0} │ Set at: ${new Date(agent.goal.setAt).toLocaleString()}`, C.dim)
              return
            }
            if (e.action === "cancel") {
              agent.goal = null
              pushLabel(`❯ Goal`, ansi.bold + C.dim)
              pushLine(`Goal cancelled.`, C.dim)
              return
            }
            // set — 需要输入目标文本
            const goalText = await askQuestion("Enter goal description (; separates criteria)")
            if (!goalText) return
            const semi = goalText.indexOf("；") >= 0 ? "；" : goalText.indexOf(";") >= 0 ? ";" : null
            const objective = semi ? goalText.slice(0, semi).trim() : goalText.trim()
            const criteria = semi ? goalText.slice(semi + 1).trim() : ""
            agent.goal = { objective, criteria, setAt: Date.now(), status: "active", turnsUsed: 0, _blockTally: null }
            pushLabel(`❯ Goal`, ansi.bold + C.warn)
            pushLine(`Goal set: ${objective}`, C.tool)
            if (criteria) pushLine(`  Criteria: ${criteria}`, C.dim)
            else pushLine(`  ⚠ No criteria — agent will be asked to provide verifiable criteria when using goal set`, C.warn)
          },
        })
        return
      }
      case "/skills": {
        const { loadSkills } = await import("../skills.mjs")
        const skills = await loadSkills(agent.cwd)
        pushLabel(`❯ Skills`, ansi.bold + C.tool)
        if (skills.length === 0) {
          pushLine(" (no project skills — create .md files under .thincoder/skills/ to add some)", C.dim)
        }
        for (const s of skills) {
          pushLine(`  ${s.name}: ${s.description.slice(0, 100)}`, C.dim)
        }
        pushLine("Activate: tell the agent \"load the <name> skill\"", C.dim)
        return
      }
      case "/mcp": {
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
                  // 从配置删除
                  agent.config.mcp.servers = servers.filter((s) => s.name !== se.name)
                  await persistRaw((raw) => { raw.mcp.servers = agent.config.mcp.servers })
                  // 从工具列表删除
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
        return
      }
      case "/auto":
        agent.autoApprove = !agent.autoApprove
        agent._pendingReminders = agent._pendingReminders ?? []
        if (agent.autoApprove) {
          agent._pendingReminders.push("[System reminder: AUTO mode is now ON. All tool calls are automatically approved — you may write, edit, and run commands without asking. Use this for long autonomous tasks. The user can still interrupt.]")
        } else {
          agent._pendingReminders.push("[System reminder: AUTO mode is now OFF. Destructive tool calls now require user approval again. Confirm before writing files, running commands, or spawning subagents.]")
        }
        pushLabel(`❯ Auto`, ansi.bold + (agent.autoApprove ? C.warn : C.tool))
        pushLine(
          agent.autoApprove
            ? `AUTO ON: all tool calls (write/bash/subagent) auto-approved. For long tasks. /auto to disable.`
            : `AUTO OFF: destructive tool calls require per-use approval again.`,
          agent.autoApprove ? C.warn : C.dim,
        )
        return
      case "/think": {
        const cur = agent.provider
        const thinkingEnabled = cur.thinking?.type === "enabled" || cur.thinking?.type === undefined
        const { specForModel } = await import("../config.mjs")
        const spec = specForModel(cur.model)
        const isEffortOnly = spec.thinkApi === "effort"
        const entries = []
        if (!isEffortOnly) {
          entries.push({ type: "item", text: `Thinking: ${thinkingEnabled ? "ON" : "OFF"}`, action: thinkingEnabled ? "off" : "on" })
        }
        if (spec.reasoningEffortEnum) {
          for (const level of spec.reasoningEffortEnum) {
            const mark = cur.reasoningEffort === level ? "▸ " : "  "
            entries.push({ type: "item", text: `${mark}effort: ${level}`, action: "effort", level })
          }
        } else {
          entries.push({ type: "item", text: "effort: high", action: "effort", level: "high" })
          entries.push({ type: "item", text: "effort: max", action: "effort", level: "max" })
        }
        openPicker({
          title: "Think",
          entries,
          onSelect: async (e) => {
            if (e.action === "effort") {
              cur.reasoningEffort = e.level
              await syncProviderField("reasoningEffort", e.level)
              pushLabel(`❯ Think`, ansi.bold + C.tool)
              pushLine(`Reasoning effort set to ${e.level}`, C.tool)
            } else {
              const enable = e.action === "on"
              if (isEffortOnly) {
                if (!enable) delete cur.reasoningEffort
                else if (!cur.reasoningEffort) cur.reasoningEffort = "high"
                if (!enable) await syncProviderField("reasoningEffort", undefined)
                else await syncProviderField("reasoningEffort", cur.reasoningEffort)
              } else {
                cur.thinking = enable ? { type: "enabled" } : { type: "disabled" }
                if (!enable) delete cur.reasoningEffort
                else if (!cur.reasoningEffort) cur.reasoningEffort = "high"
                await syncProviderField("thinking", cur.thinking)
                if (!enable) await syncProviderField("reasoningEffort", undefined)
                else await syncProviderField("reasoningEffort", cur.reasoningEffort)
              }
              pushLabel(`❯ Think`, ansi.bold + C.tool)
              pushLine(`Thinking mode ${enable ? "On" : "Off"}`, C.tool)
              if (enable) pushLine(`Reasoning effort: ${cur.reasoningEffort}`, C.dim)
            }
          },
        })
        return
      }
      case "/model": {
        ctx.openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
        return
      }
      case "/provider": {
        const entries = [
          { type: "header", text: `${agent.providers.length} providers` },
          { type: "item", text: "View list", action: "list" },
          { type: "item", text: "Add provider", action: "add" },
        ]
        if (agent.providers.length > 1) {
          entries.push({ type: "item", text: "Remove provider", action: "remove" })
        }
        if (!agent.provider.apiKey) {
          entries.push({ type: "item", text: "Set API Key", action: "key" })
        } else {
          entries.push({ type: "item", text: "Change API Key", action: "key" })
        }
        openPicker({
          title: "Providers",
          entries,
          onSelect: async (e) => {
            if (e.action === "list") {
              pushLabel(`❯ Providers (${agent.providers.length})`, ansi.bold + C.tool)
              for (const p of agent.providers) {
                const active = p.name === agent.activeProvider
                pushLine(
                  `${active ? " ▸" : "  "} ${p.name.padEnd(12)} ${p.model.padEnd(20)} ${p.baseURL}${p.apiKey ? " ●key" : " ○nonekey"}${active ? " ← current" : ""}`,
                  active ? C.tool : C.dim,
                )
              }
              return
            }
            if (e.action === "remove") {
              const candidates = agent.providers.filter((p) => p.name !== agent.activeProvider)
              if (candidates.length === 0) {
                pushLine("Cannot remove current provider (switch to another with /model first)", C.warn)
                return
              }
              const removeEntries = [
                { type: "header", text: "Select provider to remove (current one cannot be removed)" },
                ...candidates.map((p) => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
              ]
              openPicker({
                title: "Remove Provider",
                entries: removeEntries,
                onSelect: async (se) => {
                  const at = agent.providers.findIndex((p) => p.name === se.name)
                  agent.providers.splice(at, 1)
                  await persistRaw((raw) => { raw.providers = agent.providers })
                  pushLine(`Removed ${se.name}`, C.tool)
                },
              })
              return
            }
            if (e.action === "add") {
              // 菜单选预设 → 输 API key → 完成
              const presetEntries = [
                { type: "header", text: "Select a preset provider" },
                ...Object.entries(PRESETS).map(([name, p]) => ({
                  type: "item",
                  text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`,
                  name,
                })),
                { type: "header", text: "Other" },
                { type: "item", text: "Custom (manual config)", name: "__custom__" },
              ]
              openPicker({
                title: "Add Provider",
                entries: presetEntries,
                onSelect: async (se) => {
                  if (se.name === "__custom__") {
                    // 自定义：逐项输入 name → baseURL → model → key
                    const name = await askQuestion("Enter provider name:")
                    if (!name) return
                    if (agent.providers.some((p) => p.name === name)) {
                      pushLine(`"${name}" already exists — remove it via /provider first`, C.warn)
                      return
                    }
                    const baseURLRaw = await askQuestion("Enter baseURL (e.g. https://api.example.com/v1):")
                    if (!baseURLRaw) { pushLine("Cancelled", C.dim); return }
                    const baseURL = baseURLRaw.replace(/\/+$/, "")
                    if (!/^https?:\/\//.test(baseURL)) { pushLine(`baseURL must start with http(s)://`, C.error); return }
                    const model = await askQuestion("Enter model name:")
                    if (!model) { pushLine("Cancelled", C.dim); return }
                    agent.providers.push({ name, baseURL, model })
                    await persistRaw((raw) => { raw.providers = agent.providers })
                    pushLabel(`❯ Provider`, ansi.bold + C.tool)
                    pushLine(`Added ${name} (${baseURL} / ${model})`, C.tool)
                    const key = await askQuestion(`Enter API key for ${name} (leave empty to skip):`)
                    if (key) { await ctx.setProviderKey(name, key); pushLine(`Key saved for ${name}`, C.tool) }
                    else { pushLine(`Skipped key. Configure later via /provider → Set API Key`, C.dim) }
                    return
                  }
                  // 预设：name/baseURL/model 全自动填
                  const preset = PRESETS[se.name]
                  if (agent.providers.some((p) => p.name === se.name)) {
                    pushLine(`"${se.name}" already exists — remove it via /provider first`, C.warn)
                    return
                  }
                  const providerCfg = { name: se.name, baseURL: preset.baseURL, model: preset.model }
                  if (preset.thinking) providerCfg.thinking = preset.thinking
                  if (preset.reasoningEffort) providerCfg.reasoningEffort = preset.reasoningEffort
                  if (preset.maxTokens) providerCfg.maxTokens = preset.maxTokens
                  if (preset.chatPath) providerCfg.chatPath = preset.chatPath
                  if (preset.desc) providerCfg.desc = preset.desc
                  agent.providers.push(providerCfg)
                  await persistRaw((raw) => { raw.providers = agent.providers })
                  pushLabel(`❯ Provider`, ansi.bold + C.tool)
                  pushLine(`Added ${se.name} (${preset.baseURL} / ${preset.model})`, C.tool)
                  // 直接接 key 输入
                  const presetKey = await askQuestion(`Enter API key for ${se.name} (leave empty to skip; configure later via /provider → Set Key):`)
                  if (presetKey) {
                    await ctx.setProviderKey(se.name, presetKey)
                    pushLine(`Key saved for ${se.name}`, C.tool)
                  } else {
                    pushLine(`Skipped key. Configure later via /provider → Set API Key`, C.dim)
                  }
                },
              })
              return
            }
            if (e.action === "key") {
              // Key: pick which provider, then prompt for key
              const keyEntries = [
                { type: "header", text: "Select provider to configure key" },
                ...agent.providers.map((p) => ({ type: "item", text: `${p.name} ${p.apiKey ? `(has key: ${maskKey(p.apiKey)})` : "(no key)"}`, name: p.name })),
              ]
              openPicker({
                title: "Configure API Key",
                entries: keyEntries,
                onSelect: async (se) => {
                  const key = await askQuestion(`Enter API key for ${se.name}:`)
                  if (!key) {
                    pushLine(`Skipped key entry`, C.dim)
                    return
                  }
                  await ctx.setProviderKey(se.name, key)
                },
              })
            }
          },
        })
        return
      }
      case "/config": {
        const { configPath } = await import("../config.mjs")
        const cp = configPath
        const ac = agent.config?.agent ?? {}
        const entries = [
          { type: "header", text: "Current config" },
          { type: "item", text: "Set embedding key (vector search)", action: "embedkey" },
          { type: "item", text: "Advanced (set path value)", action: "set" },
        ]
        openPicker({
          title: "Config",
          entries,
          onSelect: async (e) => {
            if (e.action === "view") {
              pushLabel(`❯ Config`, ansi.bold + C.tool)
              pushLine(`Active: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
              pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
              const tn = `${ac.compactThreshold ?? 100000}${ac.compactThresholdAuto ? " (auto)" : ""}`
              pushLine(`agent:  maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${tn}`, C.dim)
              pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${agent.config?.embedding?.model ?? ""})` : "disabled (FTS only)"}`, C.dim)
              pushLine(`Config file: ${cp}`, C.dim)
              return
            }
            if (e.action === "embedkey") {
              const embKey = await askQuestion("Enter embedding API key (default: SiliconFlow bge-m3):")
              if (!embKey) return
              agent.config.embedding ??= {}
              agent.config.embedding.apiKey = embKey
              await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: embKey } })
              if (agent.memory) {
                const { createEmbedder } = await import("../embedding.mjs")
                agent.memory.embedder = createEmbedder(agent.config.embedding)
              }
              pushLabel(`❯ Config`, ansi.bold + C.tool)
              pushLine(`Embedding key saved, vector search enabled`, C.tool)
              return
            }
            if (e.action === "set") {
              const settext = await askQuestion("Enter: <path> <value> (e.g. agent.maxTurns 80, supports a.b nesting):")
              if (!settext) return
              const parts = settext.split(/\s+/)
              const [path, value] = [parts[0], parts.slice(1).join(" ")]
              if (!path || !value) { pushLine("Usage: <path> <value>  e.g. agent.maxTurns 80", C.error); return }
              try {
                const { configPath, loadConfig, saveConfig } = await import("../config.mjs")
                const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
                const keys = path.split(".")
                let obj = raw
                for (let i = 0; i < keys.length - 1; i++) { obj[keys[i]] ??= {}; obj = obj[keys[i]] }
                obj[keys[keys.length - 1]] = isNaN(value) ? value : Number(value)
                saveConfig(raw)
                const cfg = loadConfig()
                agent.provider = cfg.provider
                agent.providers = cfg.providersList
                agent.activeProvider = cfg.activeProvider
                agent.config = cfg
                pushLabel(`❯ Config`, ansi.bold + C.tool)
                pushLine(`Saved: ${path} = ${value}`, C.tool)
              } catch (error) {
                pushLine(`Save failed: ${error.message}`, C.error)
              }
            }
          },
        })
        return
      }
      case "/extract": {
        await ctx.runDistill()
        return
      }
      case "/help": {
        const aliasList = { "/help": "/h", "/exit": "/x", "/model": "/m", "/plan": "/p", "/think": "/t", "/clear": "/c", "/new": "/n" }
        const order = ["Agent", "Session", "Tools", "Config"]
        const byGroup = new Map()
        for (const c of SLASH_COMMANDS) {
          if (!c.group) continue
          if (!byGroup.has(c.group)) byGroup.set(c.group, [])
          byGroup.get(c.group).push(c)
        }
        pushLabel(`❯ Help`, ansi.bold + C.tool)
        for (const group of order) {
          const cmds = byGroup.get(group)
          if (!cmds) continue
          pushLine(`  ${group}:`, C.dim)
          for (const c of cmds) {
            const alias = aliasList[c.name]
            pushLine(`    ${c.name.padEnd(12)}${alias ? ` (${alias})`.padEnd(8) : "        "} ${c.desc}`, C.text)
          }
        }
        return
      }
      default:
        pushLine(`Unknown command: ${cmd} (/help for available commands)`, C.error)
        return
    }
  }

  /** Tab 补全候选：Commands 名 / 子 Commands / provider 名 / 预设名 / think 参数 */
  function completions(input) {
    if (!input.startsWith("/")) return []
    const parts = input.split(/\s+/)
    // 还在敲第一个 token：补 Commands 名
    if (parts.length === 1) {
      return SLASH_COMMANDS.filter((c) => c.name.startsWith(parts[0])).map((c) => c.name)
    }
    const cmd = parts[0]
    const last = parts.at(-1) // 结尾是空格时，列出全部候选
    const head = parts.slice(0, -1).join(" ")
    const argIndex = parts.length - 2 // 正在敲第几个参数 (0 基）
    const match = (cands) => cands.filter((c) => c.startsWith(last)).map((c) => `${head} ${c}`)
    if (cmd === "/model" && argIndex === 0) return match(agent.providers.map((p) => p.name))
    if (cmd === "/provider") {
      if (argIndex === 0) return match(["add", "remove", "key"])
      if (argIndex === 1 && parts[1] === "add") return match(Object.keys(PRESETS))
      if (argIndex === 1 && (parts[1] === "remove" || parts[1] === "key")) return match(agent.providers.map((p) => p.name))
    }
    if (cmd === "/think") {
      if (argIndex === 0) return match(["on", "off", "effort"])
      if (argIndex === 1 && parts[1] === "effort") return match(["low", "high", "max"])
    }
    if (cmd === "/config" && argIndex === 0) return match(["embedkey", "set"])
    if (cmd === "/goal" && argIndex === 0) return match(["set", "cancel"])
    if (cmd === "/mcp") {
      if (argIndex === 0) return match(["add", "url", "ws", "remove", "connect", "list"])
      if (argIndex === 1 && (parts[1] === "remove" || parts[1] === "connect")) return match((agent.config?.mcp?.servers ?? []).map((s) => s.name))
    }
    return []
  }

  /** Tab：计算候选并循环替换输入 */
  function handleTab() {
    const input = state.input.join("")
    if (state.completion && input === state.completion.candidates[state.completion.index]) {
      // 上一次的候选还在输入框：循环到下一个
      state.completion.index = (state.completion.index + 1) % state.completion.candidates.length
    } else {
      const candidates = completions(input)
      if (candidates.length === 0) return
      state.completion = { candidates, index: 0 }
    }
    const text = state.completion.candidates[state.completion.index]
    state.input = [...text]
    state.cursor = state.input.length
    render()
  }

  return { handleSlash, completions, handleTab }
}
