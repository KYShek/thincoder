/**
 * tui-render-frame.mjs — 终端帧渲染（纯计算，无副作用）
 * 从 state + agent 产生 ANSI 帧字符串，返回光标位置。
 */

import { ansi, C, ESC } from "./ansi.mjs"
import {
  sliceByWidth, stringWidth, wrapText, formatTables, sanitizeDisplay, layoutInput,
} from "./render.mjs"
import { specForModel } from "../config.mjs"
import { estimateTokens } from "../context.mjs"
import { basename } from "node:path"

/**
 * 渲染一帧，返回 { frame, cursorRow, cursorCol }。
 * state: TUI state 对象（会被读取和部分修改，如 scroll 归位）
 * agent: agent 对象
 * opts.cols, opts.rows: 终端尺寸
 * opts.slashCommands: SLASH_COMMANDS 数组（用于状态栏补全提示）
 * opts.platform: process.platform 的值
 */
export function renderFrame(state, agent, opts) {
  const cols = opts.cols || 80
  const rows = opts.rows || 24
  const slashCommands = opts.slashCommands ?? []
  const platform = opts.platform ?? process.platform
  const model = agent.provider.model
  const thinking = agent.provider.thinking
  const effort = agent.provider.reasoningEffort
  const isMultimodal = specForModel(model).multimodal
  const thinkBadge = thinking?.type === "disabled" ? "│ think: off"
    : effort ? `│ think: ${effort}` : thinking?.type === "enabled" ? "│ think: on" : ""

  // 输入区：全边框盒，宽度 W (所有输出行严格 ≤ cols-1，防自动折行错位）
  const W = Math.max(20, cols - 1)
  const layout = layoutInput(state.input, state.cursor, W - 4)
  const MAX_INPUT_LINES = 5
  let inputOffset = 0
  if (layout.lines.length > MAX_INPUT_LINES) {
    inputOffset = Math.min(layout.cursorLine, layout.lines.length - MAX_INPUT_LINES)
  }
  const inputLines = layout.lines.slice(inputOffset, inputOffset + MAX_INPUT_LINES)
  let boxLines = inputLines
  if (state.question) {
    const q = state.question
    if (q.options.length > 0) {
      const sel = q.selected ?? 0
      const QWIN = 5
      const start = Math.max(0, Math.min(sel - 2, q.options.length - QWIN))
      boxLines = q.options
        .slice(start, start + QWIN)
        .map((opt, i) => (start + i === sel ? "▸ " : "  ") + opt)
    } else {
      boxLines = ["▸ " + (q.answer ?? "")]
    }
  }
  const inputBoxH = boxLines.length + 2

  const headerH = 1
  const statusH = 1
  const overlay = state.picker ?? state.wizard
  const pickerH = overlay
    ? Math.min(overlay.lines.length + 1, Math.max(6, rows - 12))
    : 0
  const MAX_TASK_LINES2 = 5
  let visibleTasks = []
  if (state.tasks.length <= MAX_TASK_LINES2) {
    visibleTasks = state.tasks
  } else {
    const inProgress = state.tasks.filter((t) => t.status === "in_progress")
    const pending = state.tasks.filter((t) => t.status === "pending")
    const done = state.tasks.filter((t) => t.status === "done")
    visibleTasks = [...inProgress, ...pending, ...done].slice(0, MAX_TASK_LINES2)
  }
  const taskPanelH = visibleTasks.length
  const activeSubs = Object.values(state.subTasks).filter((s) => !s.done)
  const subPanelH = Math.min(activeSubs.length, 4)
  const subOutLen = subPanelH
  let permPreviewLines = []
  if (state.permission) {
    const maxLines = Math.max(1, rows - 8)
    outer: for (const l of state.permissionPreview) {
      for (const wrapped of wrapText(`  ${l}`, W - 1)) {
        if (permPreviewLines.length >= maxLines) break outer
        permPreviewLines.push(wrapped)
      }
    }
  }
  const permPreviewLen = state.permission ? 1 + permPreviewLines.length : 0
  const convH = Math.max(1, rows - headerH - inputBoxH - statusH - pickerH - taskPanelH - subOutLen - permPreviewLen)

  // 对话区内容行
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

  const maxScroll = Math.max(0, convLines.length - convH)
  state.scroll = Math.min(state.scroll, maxScroll)
  const end = convLines.length - state.scroll
  const visible = convLines.slice(Math.max(0, end - convH), end)

  const out = [ansi.home]

  // header
  out.push(
    `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${sliceByWidth(model, 30)}${thinkBadge ? " " + thinkBadge : ""} │ ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 60))}${ansi.reset}${ansi.clearLine}`,
  )

  // 对话区
  const pad = convH - visible.length
  for (let i = 0; i < pad; i++) out.push(ansi.clearLine)
  for (const l of visible) {
    out.push(`${l.color}${l.text}${ansi.reset}${ansi.clearLine}`)
  }

  // 浮层
  if (overlay) {
    const winH = pickerH - 1
    if (overlay.selectedLine < overlay.scroll) overlay.scroll = overlay.selectedLine
    if (overlay.selectedLine >= overlay.scroll + winH) overlay.scroll = overlay.selectedLine - winH + 1
    const start = Math.max(0, Math.min(overlay.scroll, Math.max(0, overlay.lines.length - winH)))
    const shown = overlay.lines.slice(start, start + winH)
    const overlayTitle = state.picker ? ` ❯ ${state.picker.title} ` : " ❯ 初始Config "
    out.push(`${ansi.bold}${C.tool}${overlayTitle}${ansi.reset}${ansi.dim}${state.picker ? "(↑↓ 移动, Enter 确认, Esc 取消)" : ""}${ansi.reset}${ansi.clearLine}`)
    for (const l of shown) {
      out.push(`${l.color}${sliceByWidth(l.text, cols - 1)}${ansi.reset}${ansi.clearLine}`)
    }
    for (let i = shown.length; i < winH; i++) out.push(ansi.clearLine)
  }

  // todo 面板
  for (const t of visibleTasks) {
    const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
    const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text
    out.push(`${color} ${mark} ${sliceByWidth(t.title, cols - 4)}${ansi.reset}${ansi.clearLine}`)
  }

  // 子 agent 面板
  const subs = Object.values(state.subTasks)
  if (subs.length > 0 && state.processing) {
    for (const s of subs.slice(0, 4)) {
      const icon = s.done ? "✓" : "…"
      const color = s.done ? C.dim : C.tool
      const label = `[${s.role}]`.padEnd(10)
      const text = s.text ? sliceByWidth(s.text, W - 14) : (s.done ? "done" : "running...")
      out.push(`${color} ${icon} ${label} ${text}${ansi.reset}${ansi.clearLine}`)
    }
    if (subs.length > 4) {
      out.push(`${C.dim}  ... +${subs.length - 4} more subagents${ansi.reset}${ansi.clearLine}`)
    }
  }

  // 权限预览
  if (state.permission) {
    out.push(`${ansi.bold}${C.warn}❯ 权限请求${ansi.reset}${ansi.clearLine}`)
    for (const wrapped of permPreviewLines) {
      out.push(`${C.warn}${wrapped}${ansi.reset}${ansi.clearLine}`)
    }
  }

  // 队列预览
  if (state.queue.length > 0 && state.processing) {
    const preview = sliceByWidth(state.queue[0].text, W - 20)
    out.push(`${C.dim}❯ Queue: ${state.queue.length} pending${state.queue.length > 1 ? ` (next: ${preview}…)` : ` (next: ${preview})`} — Ctrl+D del${ansi.reset}${ansi.clearLine}`)
  }

  // 输入框
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
  let topBorder
  if (title === " Input " && isMultimodal) {
    const hint = platform === "win32" ? " Alt+V paste " : " Ctrl+V paste "
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

  // 状态栏
  const scrollHint = state.scroll > 0 ? ` │ scrolled ${state.scroll}` : ""
  const rawInput = state.input.join("")
  let statusLine
  if (state.question) {
    const q = state.question
    statusLine = q.options.length > 0
      ? " ↑↓: select │ Enter: confirm │ Esc: cancel"
      : " Type answer then Enter │ Esc: cancel"
  } else if (state.permission) {
    statusLine = state.permission.name === "continue"
      ? " y: continue │ n: stop"
      : " y: approve │ n: deny │ a: approve all (AUTO)"
  } else if (state.picker) {
    statusLine = " ↑↓: select │ Enter: confirm │ Esc: cancel"
  } else if (state.wizard) {
    statusLine = state.wizard.step === "provider"
      ? " ↑↓: select │ Enter: confirm │ Esc: skip"
      : " Type then Enter │ Esc: cancel"
  } else if (rawInput.startsWith("/") && !state.processing && !state.permission) {
    const [cmd, sub] = rawInput.split(/\s+/)
    const cmds = slashCommands.filter((c) => c.name.startsWith(cmd))
    const match = cmds.length === 1 ? cmds[0] : null
    if (match?.name === "/config" && cmd === "/config") {
      statusLine = " /config open config menu"
    } else if (match?.name === "/provider" && cmd === "/provider") {
      statusLine = " /provider open provider management menu"
    } else if (match?.name === "/model" && cmd === "/model" && !sub) {
      statusLine = " /model open model picker"
    } else if (match?.name === "/think" && cmd === "/think") {
      statusLine = " /think open thinking mode menu"
    } else if (match?.name === "/mcp" && cmd === "/mcp") {
      statusLine = " /mcp open MCP management menu"
    } else if (match?.name === "/goal" && cmd === "/goal") {
      statusLine = " /goal open goal management menu"
    } else if (match?.name === "/session" && cmd === "/session") {
      statusLine = " /session select archived session"
    } else if (match?.name === "/restore" && cmd === "/restore") {
      statusLine = " /restore select checkpoint to restore"
    } else if (cmds.length > 0) {
      if (cmds.length <= 4) {
        statusLine = ` ${cmds.map((c) => `${c.name} ${c.desc}`).join("  │  ")}`
      } else {
        statusLine = ` ${cmds.map((c) => c.name).join("  ")}  │  Tab complete`
      }
    } else {
      statusLine = ` unknown command (/help for available commands)`
    }
  } else {
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
    if (state.ctxCache.len !== agent.history.length) {
      state.ctxCache = { len: agent.history.length, tokens: estimateTokens(agent.history) }
    }
    const ctxThreshold = agent.config?.agent?.compactThreshold ?? 100_000
    const ctxPct = Math.round((state.ctxCache.tokens / ctxThreshold) * 100)
    const ctxHint = ctxPct > 0
      ? ctxPct >= 80
        ? ` │ ${ansi.reset}${C.warn}ctx ${ctxPct}%${ansi.reset}${ansi.dim}`
        : ` │ ctx ${ctxPct}%`
      : ""
    const queueHint = state.queue.length > 0 ? ` │ queue: ${state.queue.length}` : ""
    statusLine = ` ${statusText}${taskHint}${tokenHint}${ctxHint}${queueHint}${scrollHint} │ Enter: send${state.processing ? " (queue)" : ""} │ /: commands │ wheel/PgUp/PgDn: scroll │ Ctrl+C: exit`
  }
  const autoBanner = agent.autoApprove ? `${C.warn} AUTO${ansi.reset}${ansi.dim}│` : ""
  const planBanner = agent.planMode ? `${C.tool} PLAN${ansi.reset}${ansi.dim}│` : ""
  const bannerPrefix = (agent.planMode ? " PLAN│ " : "") + (agent.autoApprove ? " AUTO│ " : "")
  const statusMax = cols - 1 - (bannerPrefix ? stringWidth(bannerPrefix) : 0)
  statusLine = sliceByWidth(statusLine, Math.max(10, statusMax))
  out.push(`${ansi.dim}${planBanner}${autoBanner}${statusLine}${ansi.reset}${ansi.clearLine}`)

  const frame = out.join("\r\n")

  // 光标位置
  let cursorRow = 0, cursorCol = 0
  if (!state.permission && !state.question && !state.picker && state.wizard?.step !== "provider") {
    cursorRow = 1 + convH + pickerH + taskPanelH + 2 + (layout.cursorLine - inputOffset)
    cursorCol = 3 + layout.cursorCol
  }

  return { frame, cursorRow, cursorCol }
}
