/**
 * render-frame.mjs — terminal frame renderer (pure computation, no side effects)
 * Produces an ANSI frame string from state + agent + layout, returns cursor position.
 *
 * Layout calculation lives in layout.mjs (computeLayout pure function).
 * Side effects (scroll clamping, ctxCache update) are performed by the caller before rendering.
 */
import { ansi, C, ESC } from "./ansi.mjs"
import { computeLayout, MAX_SUB_LINES } from "./layout.mjs"
import {
  sliceByWidth, stringWidth, wrapText, formatTables, sanitizeDisplay,
} from "./render.mjs"
import { specForModel } from "../config.mjs"
import { basename } from "node:path"

// ---------- status bar slash-command hints (lookup table instead of if-else chain) ----------
const SLASH_HINTS = {
  "/config": "open config menu",
  "/model": "select model & manage providers",
  "/think": "open thinking mode menu",
  "/mcp": "open MCP management menu",
  "/goal": "open goal management menu",
  "/session": "select archived session",
  "/restore": "select checkpoint to restore",
}

/**
 * Render one frame, returns { frame, cursorRow, cursorCol }.
 * Pure function: does not modify state/agent.
 */
export function renderFrame(state, agent, opts) {
  const cols = opts.cols || 80
  const rows = opts.rows || 24
  const slashCommands = opts.slashCommands ?? []
  const platform = opts.platform ?? process.platform

  const layout = computeLayout(state, { cols, rows })
  const { W, panels, inputLayout, inputOffset, boxLines, visibleTasks, allSubs, permPreviewLines, overlay } = layout
  const model = agent.provider.model
  const thinking = agent.provider.thinking
  const effort = agent.provider.reasoningEffort
  const isMultimodal = specForModel(model).multimodal
  const thinkBadge = thinking?.type === "disabled" ? "│ think: off"
    : effort ? `│ think: ${effort}` : thinking?.type === "enabled" ? "│ think: on" : ""

  const out = [ansi.home]
  let cursorRow = 0, cursorCol = 0

  // ---- header ----
  out.push(
    `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${sliceByWidth(model, 30)}${thinkBadge ? " " + thinkBadge : ""} │ ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 60))}${ansi.reset}${ansi.clearLine}`,
  )

  // ---- conversation ----
  const convLines = buildConvLines(state, cols)
  const maxScroll = Math.max(0, convLines.length - panels.conversation.h)
  const scroll = Math.min(state.scroll, maxScroll)
  const end = convLines.length - scroll
  const visible = convLines.slice(Math.max(0, end - panels.conversation.h), end)
  const pad = panels.conversation.h - visible.length
  for (let i = 0; i < pad; i++) out.push(ansi.clearLine)
  for (const l of visible) {
    out.push(`${l.color}${l.text}${ansi.reset}${ansi.clearLine}`)
  }

  // ---- picker / wizard overlay ----
  if (panels.picker) {
    const winH = panels.picker.h - 1
    const start = Math.max(0, Math.min(overlay.scroll, Math.max(0, overlay.lines.length - winH)))
    const shown = overlay.lines.slice(start, start + winH)
    const overlayTitle = state.picker ? ` ❯ ${state.picker.title} ` : " ❯ Setup "
    out.push(`${ansi.bold}${C.tool}${overlayTitle}${ansi.reset}${ansi.dim}${state.picker ? "(↑↓ navigate, Enter confirm, Esc cancel)" : ""}${ansi.reset}${ansi.clearLine}`)
    for (const l of shown) {
      out.push(`${l.color}${sliceByWidth(l.text, cols - 1)}${ansi.reset}${ansi.clearLine}`)
    }
    for (let i = shown.length; i < winH; i++) out.push(ansi.clearLine)
  }

  // ---- todo panel ----
  for (const t of visibleTasks) {
    const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
    const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text
    out.push(`${color} ${mark} ${sliceByWidth(t.title, cols - 4)}${ansi.reset}${ansi.clearLine}`)
  }

  // ---- subagent panel ----
  if (panels.subagent) {
    const subs = allSubs
    for (const s of subs.slice(0, MAX_SUB_LINES)) {
      const icon = s.done ? "✓" : "…"
      const color = s.done ? C.dim : C.tool
      const label = `[${s.role}]`.padEnd(10)
      let content
      if (s.done) {
        const elapsed = Math.floor((Date.now() - s.started) / 1000)
        content = `done ${elapsed}s`
      } else if (s.tool) {
        const argSummary = s.toolArgs ? summarizeToolArg(s.tool, s.toolArgs) : ""
        content = `${s.tool}${argSummary ? ` ${argSummary}` : ""}`
      } else if (s.text) {
        const textLines = s.text.split("\n").filter((l) => l.trim())
        content = textLines.length > 0 ? textLines[textLines.length - 1] : "thinking..."
      } else {
        content = "thinking..."
      }
      const availWidth = W - 14
      out.push(`${color} ${icon} ${label} ${sliceByWidth(content, Math.max(10, availWidth))}${ansi.reset}${ansi.clearLine}`)
    }
    if (subs.length > MAX_SUB_LINES) {
      out.push(`${C.dim}  ... +${subs.length - MAX_SUB_LINES} more subagents${ansi.reset}${ansi.clearLine}`)
    }
  }

  // ---- tool output panels (streaming output like tail -f, auto-clears when done) ----
  if (panels.output) {
    const active = Object.values(state.outputPanels).filter((p) => !p.done)
    if (active.length > 0) {
      const linesPerPanel = Math.max(1, Math.floor(panels.output.h / active.length))
      for (const p of active) {
        const textLines = (p.text ?? "").split("\n").filter((l) => l.trim())
        const tail = textLines.slice(-linesPerPanel)
        for (const line of tail) {
          out.push(`${C.dim}  │ ${sliceByWidth(sanitizeDisplay(line), W - 5)}${ansi.reset}${ansi.clearLine}`)
        }
      }
      // fill remaining rows
      const used = active.reduce((s, p) => {
        const tl = (p.text ?? "").split("\n").filter((l) => l.trim()).slice(-linesPerPanel)
        return s + tl.length
      }, 0)
      for (let i = used; i < panels.output.h; i++) {
        out.push(ansi.clearLine)
      }
    }
  }

  // ---- permission preview ----
  if (panels.permission) {
    out.push(`${ansi.bold}${C.warn}❯ Permission Request${ansi.reset}${ansi.clearLine}`)
    for (const wrapped of permPreviewLines) {
      out.push(`${C.warn}${wrapped}${ansi.reset}${ansi.clearLine}`)
    }
  }

  // ---- queue preview ----
  if (panels.queue) {
    const preview = sliceByWidth(state.queue[0].text, W - 20)
    out.push(`${C.dim}❯ Queue: ${state.queue.length} pending${state.queue.length > 1 ? ` (next: ${preview}…)` : ` (next: ${preview})`} — Ctrl+D delete${ansi.reset}${ansi.clearLine}`)
  }

  // ---- input box ----
  const { borderColor, title } = inputBoxStyle(state)
  let topBorder
  if (title === " Input " || title === " Question ") {
    const parts = []
    if (title === " Input ") parts.push(" Ctrl+U clear ")
    if (title === " Question ") parts.push(" Enter submit ")
    parts.push(" Ctrl+V paste ")
    const hint = parts.join("")
    topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 4 - stringWidth(title) - stringWidth(hint)))}${hint}─╮`
  } else {
    topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 3 - stringWidth(title)))}╮`
  }
  out.push(`${borderColor}${topBorder}${ansi.reset}${ansi.clearLine}`)
  for (const l of boxLines) {
    const content = sliceByWidth(l, W - 4)
    const fill = " ".repeat(Math.max(0, W - 4 - stringWidth(content)))
    out.push(`${borderColor}│${ansi.reset} ${content}${fill} ${borderColor}│${ansi.reset}${ansi.clearLine}`)
  }
  out.push(`${borderColor}╰${"─".repeat(Math.max(0, W - 2))}╯${ansi.reset}${ansi.clearLine}`)

  // ---- status bar ----
  const statusLine = buildStatusLine(state, agent, { cols, slashCommands })
  const autoBanner = agent.autoApprove ? `${C.warn} AUTO${ansi.reset}${ansi.dim}│` : ""
  const planBanner = agent.planMode ? `${C.tool} PLAN${ansi.reset}${ansi.dim}│` : ""
  const bannerPrefix = (agent.planMode ? " PLAN│ " : "") + (agent.autoApprove ? " AUTO│ " : "")
  const statusMax = cols - 1 - (bannerPrefix ? stringWidth(bannerPrefix) : 0)
  out.push(`${ansi.dim}${planBanner}${autoBanner}${sliceByWidth(statusLine, Math.max(10, statusMax))}${ansi.reset}${ansi.clearLine}`)

  const frame = out.join("\r\n")

  // ---- cursor ----
  if (!state.permission && !state.question && !state.picker && state.wizard?.step !== "provider") {
    cursorRow = panels.inputBox.y + 1 + (inputLayout.cursorLine - inputOffset) + 1
    cursorCol = 3 + inputLayout.cursorCol
  }

  return { frame, cursorRow, cursorCol }
}

// ---------------------------------------------------------- internal helpers

/** Count conversation lines after sanitize + wrap (for scroll clamping). Pure. */
export function countConvLines(state, cols) {
  return buildConvLines(state, cols).length
}

/** Build conversation lines from state (sanitized + wrapped). Pure.
 *  Cached: avoids O(n) rebuild on cursor moves — only recomputes when conversation grows/changes. */
let _convCache = { key: "", cols: 0, lines: [] }
function buildConvLines(state, cols) {
  // Cheap cache key: structural hints that change whenever the conversation changes
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  const key = `${state.lines.length}|${lastLine?.text.length ?? 0}|${state.streaming.length}|${state.reasoning.length}|${Object.keys(state.toolStreams).length}`
  if (_convCache.key === key && _convCache.cols === cols) return _convCache.lines

  const convLines = []
  for (const l of state.lines) {
    for (const line of formatTables(sanitizeDisplay(l.text), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: l.color })
      }
    }
  }
  if (state.reasoning) {
    for (const wrapped of wrapText(sanitizeDisplay(state.reasoning), cols - 1)) {
      convLines.push({ text: wrapped, color: C.reason })
    }
  }
  if (state.streaming) {
    for (const line of formatTables(sanitizeDisplay(state.streaming), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: C.text })
      }
    }
  }
  const allStreams = Object.values(state.toolStreams).join("")
  if (allStreams) {
    const tail = sanitizeDisplay(allStreams.slice(-4000))
    for (const wrapped of wrapText(tail, cols - 1)) {
      convLines.push({ text: wrapped, color: C.dim })
    }
  }
  _convCache = { key, cols, lines: convLines }
  return convLines
}

/** Determine input box border color and title. Pure. */
function inputBoxStyle(state) {
  let borderColor = C.tool
  let title
  if (state.question) {
    borderColor = C.tool
    title = " Question "
  } else if (state.permission) {
    borderColor = C.warn
    if (state.permission.name === "continue") {
      title = " Continue? (y/n) "
    } else {
      title = ` Allow ${state.permission.name}? (y/n/a) `
    }
  } else if (state.picker) {
    title = " Select "
  } else if (state.wizard) {
    title = " Setup "
  } else if (state.processing) {
    title = " Processing... "
  } else {
    title = " Input "
  }
  return { borderColor, title }
}

/** Build status bar line. Pure. */
function buildStatusLine(state, agent, { cols, slashCommands }) {
  const scrollHint = state.scroll > 0 ? ` │ scrolled ${state.scroll}` : ""
  const rawInput = state.input.join("")

  if (state.question) {
    const q = state.question
    return q.options.length > 0
      ? " ↑↓: select │ Enter: confirm │ Esc: cancel"
      : " Type answer then Enter │ Esc: cancel"
  }
  if (state.permission) {
    return state.permission.name === "continue"
      ? " y: continue │ n: stop"
      : " y: approve │ n: deny │ a: approve all (AUTO)"
  }
  if (state.picker) {
    return " ↑↓: select │ Enter: confirm │ Esc: cancel"
  }
  if (state.wizard) {
    return state.wizard.step === "provider"
      ? " ↑↓: select │ Enter: confirm │ Esc: skip"
      : " Type then Enter │ Esc: cancel"
  }
  if (rawInput.startsWith("/") && !state.processing && !state.permission) {
    const [cmd] = rawInput.split(/\s+/)
    const cmds = slashCommands.filter((c) => c.name.startsWith(cmd))
    const match = cmds.length === 1 ? cmds[0] : null
    if (match && SLASH_HINTS[match.name]) {
      return ` ${match.name} ${SLASH_HINTS[match.name]}`
    }
    if (cmds.length > 0) {
      if (cmds.length <= 4) {
        return ` ${cmds.map((c) => `${c.name} ${c.desc}`).join("  │  ")}`
      }
      return ` ${cmds.map((c) => c.name).join("  ")}  │  Tab complete`
    }
    return ` unknown command (/help for available commands)`
  }

  const taskHint = state.tasks.length > 0
    ? ` │ ✓${state.tasks.filter((t) => t.status === "done").length}/${state.tasks.length}`
    : ""
  const tk = state.tokens
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
  const cacheTotal = tk.cacheHit + tk.cacheMiss
  const tokenHint = tk.prompt > 0
    ? ` │ ↑${fmtK(tk.prompt)} ↓${fmtK(tk.completion)}${cacheTotal > 0 ? ` hit${Math.round((tk.cacheHit / cacheTotal) * 100)}%` : ""}`
    : ""
  const elapsed = state.processing ? ` ${Math.floor((Date.now() - state.processingStarted) / 1000)}s` : ""
  const toolHint = state.currentTool ? ` ${state.currentTool}…` : ""
  const statusText = state.processing ? `${state.status}${toolHint}${elapsed}` : state.status
  const ctxThreshold = agent.config?.agent?.compactThreshold ?? 100_000
  const ctxPct = Math.round((state.ctxCache.tokens / ctxThreshold) * 100)
  const ctxHint = ctxPct > 0
    ? ctxPct >= 80
      ? ` │ ${ansi.reset}${C.warn}context ${ctxPct}%${ansi.reset}${ansi.dim}`
      : ` │ context ${ctxPct}%`
    : ""
  const queueHint = state.queue.length > 0 ? ` │ queue: ${state.queue.length}` : ""
  return ` ${statusText}${taskHint}${tokenHint}${ctxHint}${queueHint}${scrollHint} │ Enter: send${state.processing ? " (queue)" : ""} │ /: commands │ wheel/PgUp/PgDn: scroll │ Ctrl+C: exit`
}

/** Summarize tool args for subagent panel display (one line, short). Pure. */
function summarizeToolArg(toolName, args) {
  if (!args || typeof args !== "object") return ""
  if (toolName === "bash" && args.command) {
    const cmd = args.command.split("\n")[0]
    return `"${sliceByWidth(cmd, 50)}"`
  }
  if (args.path) return sliceByWidth(args.path, 60)
  if (args.pattern) return `"${sliceByWidth(args.pattern, 50)}"`
  if (args.query) return `"${sliceByWidth(args.query, 50)}"`
  if (args.task) return `"${sliceByWidth(args.task, 50)}"`
  return ""
}
