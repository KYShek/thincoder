/**
 * render-frame.mjs — terminal frame renderer (pure computation, no side effects)
 * Produces an ANSI frame string from state + agent + layout, returns cursor position.
 *
 * Panel render functions are exported individually for incremental rendering
 * (only changed panels are written to the terminal, eliminating flicker on Windows).
 * The legacy renderFrame() wrapper is kept for compatibility.
 */
import { ansi, C, ESC } from "./ansi.mjs"
import { computeLayout, MAX_SUB_LINES } from "./layout.mjs"
import {
  sliceByWidth, stringWidth, wrapText, formatTables, sanitizeDisplay,
} from "./render.mjs"
import { specForModel } from "../config.mjs"
import { basename } from "node:path"

// ---------- status bar slash-command hints ----------
const SLASH_HINTS = {
  "/config": "open config menu",
  "/model": "select model & manage providers",
  "/think": "open thinking mode menu",
  "/mcp": "open MCP management menu",
  "/goal": "open goal management menu",
  "/session": "select archived session",
  "/restore": "select checkpoint to restore",
}

// ====================================================================
// Panel render functions (exported for incremental rendering)
// Each returns string[] — one element per screen row, ANSI-colored,
// WITHOUT \x1b[K (clear-line) or cursor positioning (added by caller).
// ====================================================================

/** Header panel (always 1 line). */
export function renderHeader(agent, cols) {
  const model = agent.provider.model
  const spec = specForModel(model)
  const thinkOnValue = spec.thinkEnabledValue ?? "enabled"
  const t = agent.provider.thinking
  const effort = agent.provider.reasoningEffort
  const thinkBadge = t?.type === "disabled" ? "│ think: off"
    : effort ? `│ think: ${effort}`
    : t?.type === thinkOnValue ? "│ think: on" : ""
  return `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${sliceByWidth(model, 30)}${thinkBadge ? " " + thinkBadge : ""} │ ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 60))}${ansi.reset}`
}

/**
 * Compute a cheap cache key for the conversation panel.
 * Structural hints that change ONLY when the conversation actually changes.
 * Used by the incremental renderer to skip rebuilding convLines when nothing changed.
 */
export function convCacheKey(state) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  return `${state.lines.length}|${lastLine?.text.length ?? 0}|${state.streaming.length}|${state.reasoning.length}|${Object.keys(state.toolStreams).length}|${state.foldEnabled !== false ? "f" : "u"}`
}

/** Conversation panel (scrollable, variable height). Returns exactly `visibleH` lines. */
export function renderConversation(state, cols, visibleH, scroll) {
  const convLines = buildConvLines(state, cols)
  const maxScroll = Math.max(0, convLines.length - visibleH)
  const clamped = Math.min(scroll, maxScroll)
  const end = convLines.length - clamped
  const visible = convLines.slice(Math.max(0, end - visibleH), end)
  const pad = visibleH - visible.length
  const out = []
  for (let i = 0; i < pad; i++) out.push("")
  for (const l of visible) out.push(`${l.color}${l.text}${ansi.reset}`)
  return out
}

/** Todo/task panel. Returns empty array when no tasks visible. */
export function renderTodo(visibleTasks, cols) {
  return visibleTasks.map((t) => {
    const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
    const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text
    return `${color} ${mark} ${sliceByWidth(t.title, cols - 4)}${ansi.reset}`
  })
}

/** Subagent panel. Returns empty when no subagents. */
export function renderSubagent(allSubs, W) {
  const subs = allSubs
  if (subs.length === 0) return []
  const out = []
  for (const s of subs.slice(0, MAX_SUB_LINES)) {
    const icon = s.done ? "✓" : "…"
    const color = s.done ? C.dim : C.tool
    const label = `[${s.role}]`.padEnd(10)
    let content
    if (s.done) {
      const elapsed = Math.floor((Date.now() - s.started) / 1000)
      content = `done ${elapsed}s`
    } else if (s.tool) {
      content = s.tool
    } else if (s.text) {
      const textLines = s.text.split("\n").filter((l) => l.trim())
      content = textLines.length > 0 ? textLines[textLines.length - 1] : "thinking..."
    } else {
      content = "thinking..."
    }
    out.push(`${color} ${icon} ${label} ${sliceByWidth(content, Math.max(10, W - 14))}${ansi.reset}`)
  }
  if (subs.length > MAX_SUB_LINES) {
    out.push(`${C.dim}  ... +${subs.length - MAX_SUB_LINES} more subagents${ansi.reset}`)
  }
  return out
}

/** Tool output panels (streaming output like tail -f). Returns empty when no active output. */
export function renderOutput(state, W, panelH) {
  const active = Object.values(state.outputPanels).filter((p) => !p.done)
  if (active.length === 0) return []
  const out = []
  const linesPerPanel = Math.max(1, Math.floor(panelH / active.length))
  for (const p of active) {
    const textLines = (p.text ?? "").split("\n").filter((l) => l.trim())
    const tail = textLines.slice(-linesPerPanel)
    for (const line of tail) {
      out.push(`${C.dim}  │ ${sliceByWidth(sanitizeDisplay(line), W - 5)}${ansi.reset}`)
    }
  }
  // Fill remaining rows to match panelH exactly
  const used = active.reduce((s, p) => {
    const tl = (p.text ?? "").split("\n").filter((l) => l.trim()).slice(-linesPerPanel)
    return s + tl.length
  }, 0)
  for (let i = used; i < panelH; i++) out.push("")
  return out
}

/** Permission preview panel. Returns empty when no permission request. */
export function renderPermission(permPreviewLines) {
  if (permPreviewLines.length === 0) return []
  return [`${ansi.bold}${C.warn}❯ Permission Request${ansi.reset}`, ...permPreviewLines.map((w) => `${C.warn}${w}${ansi.reset}`)]
}

/** Queue preview (1 line when queue has items during processing). */
export function renderQueue(state, W) {
  if (state.queue.length === 0 || !state.processing) return ""
  const preview = sliceByWidth(state.queue[0].text, W - 20)
  return `${C.dim}❯ Queue: ${state.queue.length} pending${state.queue.length > 1 ? ` (next: ${preview}…)` : ` (next: ${preview})`} — Ctrl+D delete │ Ctrl+I inject${ansi.reset}`
}

/** Picker/wizard overlay panel. Returns empty when no overlay. */
export function renderPicker(state, cols, panel, overlay) {
  if (!panel || !overlay) return []
  const out = []
  const winH = panel.h - 1
  const start = Math.max(0, Math.min(overlay.scroll, Math.max(0, overlay.lines.length - winH)))
  const shown = overlay.lines.slice(start, start + winH)
  const title = state.picker ? ` ❯ ${state.picker.title} ` : " ❯ Setup "
  out.push(`${ansi.bold}${C.tool}${title}${ansi.reset}${ansi.dim}${state.picker ? "(↑↓ navigate, Enter confirm, Esc cancel)" : ""}${ansi.reset}`)
  for (const l of shown) {
    out.push(`${l.color}${sliceByWidth(l.text, cols - 1)}${ansi.reset}`)
  }
  for (let i = shown.length; i < winH; i++) out.push("")
  return out
}

/** Input box (border-bounded text entry area). Always visible. */
/**
 * Render the input box. When inputLayout is provided, renders a visual cursor
 * (SGR reverse video) so the hardware cursor can stay hidden at all times,
 * matching pi-tui's approach.
 */
export function renderInputBox(state, W, boxLines, cols, inputLayout, inputOffset) {
  const { borderColor, title } = inputBoxStyle(state)
  let topBorder
  if (title === " Input " || title === " Question " || title === " Inject Message " || title === " Processing... ") {
    const parts = []
    if (title === " Input " || title === " Processing... ") parts.push(" Ctrl+U clear ")
    if (title === " Question ") parts.push(" Enter submit ")
    if (title === " Inject Message ") parts.push(" Enter send, Esc cancel ")
    parts.push(" Ctrl+V paste ")
    parts.push(" Ctrl+I inject ")
    const hint = parts.join("")
    topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 4 - stringWidth(title) - stringWidth(hint)))}${hint}─╮`
  } else {
    topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 3 - stringWidth(title)))}╮`
  }
  const out = [`${borderColor}${topBorder}${ansi.reset}`]

  // Visual cursor position in the input box (hardware cursor stays hidden)
  const hasOverlay = state.permission || state.question || state.picker || state.wizard?.step === "provider"
  const curLine = (!hasOverlay && inputLayout) ? inputLayout.cursorLine - (inputOffset ?? 0) : -1
  const curCol = (!hasOverlay && inputLayout) ? inputLayout.cursorCol : -1

  for (let li = 0; li < boxLines.length; li++) {
    const l = boxLines[li]
    let content = sliceByWidth(l, W - 4)
    const fill = " ".repeat(Math.max(0, W - 4 - stringWidth(content)))

    if (li === curLine && curCol >= 0) {
      const beforeWidth = Math.min(curCol, stringWidth(content))
      const before = sliceByWidth(content, beforeWidth)
      const atIdx = before.length   // character index (not display width — CJK chars diverge)
      const at = content[atIdx] ?? " "
      const after = content.slice(atIdx + 1)
      content = before + `${ansi.reset}\x1b[7m${at}\x1b[27m${ansi.reset}` + after
    }

    out.push(`${borderColor}│${ansi.reset} ${content}${fill} ${borderColor}│${ansi.reset}`)
  }
  out.push(`${borderColor}╰${"─".repeat(Math.max(0, W - 2))}╯${ansi.reset}`)
  return out
}

/** Status bar (always 1 line). */
export function renderStatus(state, agent, cols, slashCommands) {
  const statusLine = buildStatusLine(state, agent, { cols, slashCommands })
  const autoBanner = agent.autoApprove ? `${C.warn} AUTO${ansi.reset}${ansi.dim}│` : ""
  const planBanner = agent.planMode ? `${C.tool} PLAN${ansi.reset}${ansi.dim}│` : ""
  const advisorBanner = agent.config?.advisor?.enabled ? `${C.advisor} ADVISOR${ansi.reset}${ansi.dim}│` : ""
  const bannerPrefix = (agent.planMode ? " PLAN│ " : "") + (agent.autoApprove ? " AUTO│ " : "") + (agent.config?.advisor?.enabled ? " ADVISOR│ " : "")
  const statusMax = cols - 1 - (bannerPrefix ? stringWidth(bannerPrefix) : 0)
  return `${ansi.dim}${planBanner}${autoBanner}${advisorBanner}${sliceByWidth(statusLine, Math.max(10, statusMax))}${ansi.reset}`
}

// ====================================================================
// Legacy: full-frame renderer (wraps individual panel functions)
// ====================================================================

/**
 * Render one frame, returns { frame, cursorRow, cursorCol }.
 * Pure function: does not modify state/agent.
 * @deprecated Prefer individual panel functions for incremental rendering.
 */
export function renderFrame(state, agent, opts) {
  const cols = opts.cols || 80
  const rows = opts.rows || 24
  const slashCommands = opts.slashCommands ?? []
  const platform = opts.platform ?? process.platform

  const layout = computeLayout(state, { cols, rows })
  const { W, panels, inputLayout, inputOffset, boxLines, visibleTasks, allSubs, permPreviewLines, overlay } = layout

  const out = [ansi.home]
  let cursorRow = 0, cursorCol = 0

  // header
  out.push(`${renderHeader(agent, cols)}\x1b[K`)

  // conversation
  for (const l of renderConversation(state, cols, panels.conversation.h, state.scroll)) {
    out.push(`${l}\x1b[K`)
  }

  // picker
  if (panels.picker) {
    for (const l of renderPicker(state, cols, panels.picker, overlay)) {
      out.push(`${l}\x1b[K`)
    }
  }

  // todo
  for (const l of renderTodo(visibleTasks, cols)) out.push(`${l}\x1b[K`)

  // subagent
  if (panels.subagent) {
    for (const l of renderSubagent(allSubs, W)) out.push(`${l}\x1b[K`)
  }

  // output panels
  if (panels.output) {
    for (const l of renderOutput(state, W, panels.output.h)) out.push(`${l}\x1b[K`)
  }

  // permission preview
  if (panels.permission) {
    for (const l of renderPermission(permPreviewLines)) out.push(`${l}\x1b[K`)
  }

  // queue preview
  if (panels.queue) {
    const qLine = renderQueue(state, W)
    if (qLine) out.push(`${qLine}\x1b[K`)
  }

  // input box
  for (const l of renderInputBox(state, W, boxLines, cols, inputLayout, inputOffset)) out.push(`${l}\x1b[K`)

  // status bar
  out.push(`${renderStatus(state, agent, cols, slashCommands)}\x1b[K`)

  const frame = out.join("\r\n")

  // cursor position
  if (!state.permission && !state.question && !state.picker && state.wizard?.step !== "provider") {
    cursorRow = panels.inputBox.y + 1 + (inputLayout.cursorLine - inputOffset) + 1
    cursorCol = 3 + inputLayout.cursorCol
  }

  return { frame, cursorRow, cursorCol }
}

// ====================================================================
// Internal helpers (unchanged from original)
// ====================================================================

export function countConvLines(state, cols) {
  return buildConvLines(state, cols).length
}

let _convCache = { key: "", cols: 0, lines: [] }
function buildConvLines(state, cols) {
  const lastLine = state.lines.length > 0 ? state.lines[state.lines.length - 1] : null
  const key = convCacheKey(state)
  if (_convCache.key === key && _convCache.cols === cols) return _convCache.lines

  const convLines = []
  for (const l of state.lines) {
    for (const line of formatTables(sanitizeDisplay(l.text), cols - 1)) {
      for (const wrapped of wrapText(line, cols - 1)) {
        convLines.push({ text: wrapped, color: l.color, _foldId: l._foldId })
      }
    }
  }
  // Messages after the conversation (streaming / thinking / tool output):
  // appended after history lines so they appear at the bottom.
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

  // ---- Fold long blocks (> 8 consecutive dim lines) ----
  const FOLD_LINES = 8
  let foldCounter = 0
  const folded = []
  let i = 0
  while (i < convLines.length) {
    const line = convLines[i]
    // Only fold dim-colored lines (tool results, subagent previews)
    if (line.color === C.dim) {
      let j = i
      while (j < convLines.length && convLines[j].color === C.dim) j++
      const blockLen = j - i
      if (blockLen > FOLD_LINES) {
        const foldKey = `fold-${foldCounter++}`
        if (state.foldEnabled !== false && !state.expandedBlocks?.has(foldKey)) {
          // Show first 2 lines + fold hint
          folded.push(convLines[i])
          if (blockLen > 2) folded.push(convLines[i + 1])
          folded.push({ text: `  … ${blockLen - 2} more lines — Enter to expand`, color: C.fold, _foldToggle: foldKey })
          i = j
          continue
        }
      }
    }
    folded.push(line)
    i++
  }

  _convCache = { key, cols, lines: folded }
  return folded
}

function inputBoxStyle(state) {
  let borderColor = C.tool
  let title
  if (state.interruptPrompt) {
    borderColor = C.warn; title = " Inject Message "
  } else if (state.question) {
    borderColor = C.tool; title = " Question "
  } else if (state.permission) {
    borderColor = C.warn
    title = state.permission.name === "continue" ? " Continue? (y/n) " : ` Allow ${state.permission.name}? (y/n/a) `
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
  if (state.picker) return " ↑↓: select │ Enter: confirm │ Esc: cancel"
  if (state.wizard) {
    return state.wizard.step === "provider"
      ? " ↑↓: select │ Enter: confirm │ Esc: skip"
      : " Type then Enter │ Esc: cancel"
  }
  if (rawInput.startsWith("/") && !state.processing && !state.permission) {
    const [cmd] = rawInput.split(/\s+/)
    const cmds = slashCommands.filter((c) => c.name.startsWith(cmd))
    const match = cmds.length === 1 ? cmds[0] : null
    if (match && SLASH_HINTS[match.name]) return ` ${match.name} ${SLASH_HINTS[match.name]}`
    if (cmds.length > 0) {
      if (cmds.length <= 4) return ` ${cmds.map((c) => `${c.name} ${c.desc}`).join("  │  ")}`
      return ` ${cmds.map((c) => c.name).join("  ")}  │  Tab complete`
    }
    return ` unknown command (/help for available commands)`
  }

  const taskHint = state.tasks.length > 0
    ? ` │ ✓${state.tasks.filter((t) => t.status === "done").length}/${state.tasks.length}` : ""
  const tk = state.tokens
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
  const cacheTotal = tk.cacheHit + tk.cacheMiss
  const tokenHint = tk.prompt > 0
    ? ` │ ↑${fmtK(tk.prompt)} ↓${fmtK(tk.completion)}${tk.reasoningTokens > 0 ? ` ✦${fmtK(tk.reasoningTokens)}` : ""}${cacheTotal > 0 ? ` hit${Math.round((tk.cacheHit / cacheTotal) * 100)}%` : ""}` : ""
  const elapsed = state.processing ? ` ${Math.floor((Date.now() - state.processingStarted) / 1000)}s` : ""
  const toolHint = state.currentTool ? ` ${state.currentTool}…` : ""
  const statusText = state.processing ? `${state.status}${toolHint}${elapsed}` : state.status
  const modelContext = specForModel(agent.provider.model).context
  const ctxPct = Math.round((state.ctxCache.tokens / modelContext) * 100)
  const ctxTokensHint = state.ctxCache.tokens > 0 ? ` ${fmtK(state.ctxCache.tokens)}` : ""
  const ctxHint = ctxPct > 0
    ? ctxPct >= 80 ? ` │ ${ansi.reset}${C.warn}context ${ctxPct}%${ctxTokensHint}${ansi.reset}${ansi.dim}` : ` │ context ${ctxPct}%${ctxTokensHint}` : ""
  const queueHint = state.queue.length > 0 ? ` │ queue: ${state.queue.length}` : ""
  return ` ${statusText}${taskHint}${tokenHint}${ctxHint}${queueHint}${scrollHint} │ Enter: send${state.processing ? " (queue)" : ""} │ /: commands │ wheel/PgUp/PgDn: scroll │ Ctrl+I: inject │ Ctrl+C: exit`
}
