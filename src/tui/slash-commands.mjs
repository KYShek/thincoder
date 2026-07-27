/**
 * slash-commands.mjs — slash command definitions, dispatch, Tab completion.
 * Each subcommand's implementation lives in its own cmd-*.mjs file; this file only does dispatch.
 *
 * ctx object is injected by index.mjs and forwarded to each handler:
 *   { agent, state, distillOpts, pushLine, pushLabel, render,
 *     openPicker, openModelPicker, setProviderKey, runDistill,
 *     persistRaw, syncProviderField, maskKey, exit, SLASH_COMMANDS }
 */

import { C } from "./ansi.mjs"
import { handleClearCommand } from "./cmd-clear.mjs"
import { handleNewCommand } from "./cmd-new.mjs"
import { handleExitCommand } from "./cmd-exit.mjs"
import { handleSessionCommand } from "./cmd-session.mjs"
import { handleReindexCommand } from "./cmd-reindex.mjs"
import { handleInitCommand } from "./cmd-init.mjs"
import { handleRestoreCommand } from "./cmd-restore.mjs"
import { handlePlanCommand } from "./cmd-plan.mjs"
import { handleGoalCommand } from "./cmd-goal.mjs"
import { handleSkillsCommand } from "./cmd-skills.mjs"
import { handleMcpCommand } from "./cmd-mcp.mjs"
import { handleAutoCommand } from "./cmd-auto.mjs"
import { handleThinkCommand } from "./cmd-think.mjs"
import { handleModelCommand } from "./cmd-model.mjs"
import { handleConfigCommand } from "./cmd-config.mjs"
import { handleExtractCommand } from "./cmd-extract.mjs"
import { handleHelpCommand } from "./cmd-help.mjs"

export const SLASH_COMMANDS = [
  { name: "/plan", group: "Agent", desc: "toggle plan mode (design first, then implement)" },
  { name: "/auto", group: "Agent", desc: "toggle auto-approve" },
  { name: "/model", group: "Agent", desc: "select model & manage providers" },
  { name: "/goal", group: "Agent", desc: "set/view/cancel long-term goal" },
  { name: "/think", group: "Agent", desc: "thinking mode & reasoning effort" },
  { name: "/init", group: "Tools", desc: "generate project AGENTS.md skeleton" },
  { name: "/skills", group: "Tools", desc: "list project skills" },
  { name: "/mcp", group: "Tools", desc: "manage MCP servers" },
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

/** Command → handler mapping table */
const HANDLERS = {
  "/clear": handleClearCommand,
  "/new": handleNewCommand,
  "/exit": handleExitCommand,
  "/session": handleSessionCommand,
  "/reindex": handleReindexCommand,
  "/init": handleInitCommand,
  "/restore": handleRestoreCommand,
  "/plan": handlePlanCommand,
  "/goal": handleGoalCommand,
  "/skills": handleSkillsCommand,
  "/mcp": handleMcpCommand,
  "/auto": handleAutoCommand,
  "/think": handleThinkCommand,
  "/model": handleModelCommand,
  "/config": handleConfigCommand,
  "/extract": handleExtractCommand,
  "/help": handleHelpCommand,
}

/**
 * Creates the slash command processor.
 * Returns { handleSlash, completions, handleTab }.
 */
export function createSlashCommands(ctx) {
  const { agent, state, render } = ctx
  // forward SLASH_COMMANDS to /help
  const handlerCtx = { ...ctx, SLASH_COMMANDS }

  async function handleSlash(text) {
    const [cmd] = text.split(/\s+/)
    // high-frequency command aliases
    const aliases = { "/h": "/help", "/x": "/exit", "/m": "/model", "/p": "/plan", "/t": "/think", "/c": "/clear", "/n": "/new" }
    const resolved = aliases[cmd] ?? cmd
    const handler = HANDLERS[resolved]
    if (handler) {
      await handler(handlerCtx)
      return
    }
    ctx.pushLine(`Unknown command: ${cmd} (/help for available commands)`, C.error)
  }

  /** Tab completion candidates: command names / subcommands / provider names / preset names / think params */
  function completions(input) {
    if (!input.startsWith("/")) return []
    const parts = input.split(/\s+/)
    // still typing the first token: complete command names
    if (parts.length === 1) {
      return SLASH_COMMANDS.filter((c) => c.name.startsWith(parts[0])).map((c) => c.name)
    }
    const cmd = parts[0]
    const last = parts.at(-1) // when trailing space, list all candidates
    const head = parts.slice(0, -1).join(" ")
    const argIndex = parts.length - 2 // which parameter is being typed (0-based)
    const match = (cands) => cands.filter((c) => c.startsWith(last)).map((c) => `${head} ${c}`)
    if (cmd === "/model" && argIndex === 0) return match(agent.providers.map((p) => p.name))
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

  /** Tab: compute candidates and cycle through replacement */
  function handleTab() {
    const input = state.input.join("")
    if (state.completion && input === state.completion.candidates[state.completion.index]) {
      // previous candidate still in input box: cycle to next
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
