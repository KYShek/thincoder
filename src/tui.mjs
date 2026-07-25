/**
 * tui.mjs — 裸 ANSI 终端 UI
 * 零依赖：raw mode 键盘输入、ANSI 转义渲染、自研宽字符换行。
 * 布局：header / 对话区（可滚动）/ todo 面板（有任务时）/ 输入框 / 状态栏。
 */

import { emitKeypressEvents } from "node:readline"
import { PassThrough } from "node:stream"
import { basename } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { runAgent, ContinueError } from "./agent.mjs"
import { estimateTokens } from "./context.mjs"
import { saveSession, clearSession, archiveCurrent, listSlots, switchToSlot, sessionPath } from "./session.mjs"
import { PROVIDER_PRESETS as PRESETS } from "./config.mjs"
import { closeAllMcp } from "./mcp.mjs"

// ---------------------------------------------------------------- ANSI 工具

const ESC = "\x1b"
const ansi = {
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  altBuffer: `${ESC}[?1049h`,
  mainBuffer: `${ESC}[?1049l`,
  mouseOn: `${ESC}[?1000h${ESC}[?1006h`, // 基本鼠标 + SGR 扩展坐标（滚轮上报）
  mouseOff: `${ESC}[?1000l${ESC}[?1006l`,
  home: `${ESC}[H`,
  clearLine: `${ESC}[K`,
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  fg: (n) => `${ESC}[${30 + n}m`,
  gray: `${ESC}[90m`,
}

const C = {
  user: ansi.fg(4), // blue（标签）
  assistant: ansi.fg(2), // green（标签）
  text: ansi.fg(7), // white（对话正文）
  reason: `${ESC}[2m${ESC}[3m`, // dim + italic（思考流）
  tool: ansi.fg(6), // cyan
  error: ansi.fg(1), // red
  dim: ansi.gray,
  warn: ansi.fg(3), // yellow
}

/** 字符显示宽度：CJK/emoji 计 2，组合字符计 0，其余计 1 */
export function charWidth(cp) {
  if (
    (cp >= 0x300 && cp <= 0x36f) || // 组合变音符
    (cp >= 0x200b && cp <= 0x200f) || // 零宽
    cp === 0xfe0f // emoji 变体选择符
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  ) {
    return 2
  }
  return 1
}

export function stringWidth(text) {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0))
  return w
}

/** 按显示宽度裁剪 */
function sliceByWidth(text, maxWidth) {
  let w = 0
  let out = ""
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > maxWidth) break
    w += cw
    out += ch
  }
  return out
}

/** 按显示宽度右补空格 */
function padByWidth(text, width) {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)))
}

// ---------------------------------------------------------------- markdown 表格重排

const isTableRow = (line) => (line.match(/\|/g) ?? []).length >= 2
const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")

/**
 * 识别文本中的 markdown 表格块，按显示宽度重排（修 CJK 错位）。
 * width 为可用显示宽度；过宽的表格按列收缩。非表格行原样保留。
 */
export function formatTables(text, width) {
  const lines = text.split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const block = [lines[i], lines[i + 1]]
      i += 2
      while (i < lines.length && isTableRow(lines[i])) {
        block.push(lines[i])
        i++
      }
      out.push(...renderTable(block, width))
    } else {
      out.push(lines[i])
      i++
    }
  }
  return out
}

function renderTable(block, width) {
  const rows = block.map((line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim()),
  )
  const colCount = Math.max(...rows.map((r) => r.length))
  for (const r of rows) while (r.length < colCount) r.push("")

  // 列宽：先按内容，超宽则从最宽列开始收缩（收缩到至少 3）
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )
  const borders = colCount * 3 + 1 // " │ " 分隔 + 首尾 |
  while (widths.reduce((a, b) => a + b, 0) + borders > width && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest]--
  }

  // 单元格渲染：sliceByWidth 截断（表头单行），padByWidth 补齐
  const fmtCell = (text, ci) => padByWidth(sliceByWidth(text, widths[ci]), widths[ci])
  const fmtRow = (cells) => "│ " + cells.map((c, i) => fmtCell(c, i)).join(" │ ") + " │"

  // 分隔线
  const separator = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤"

  const out = []
  // 表头：单行截断（表头通常是短标签，折行不如截断直观）
  out.push(fmtRow(rows[0]))
  out.push(separator)

  // 数据行：过长单元格按列宽折行，一个逻辑行可能对应多条显示行
  for (let r = 2; r < rows.length; r++) {
    // wrapText 返回按 width 折行后的行数组，保留内部 \n
    const wrapped = rows[r].map((cell, ci) => wrapText(cell, widths[ci]))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    for (let lineIdx = 0; lineIdx < height; lineIdx++) {
      out.push(fmtRow(wrapped.map((lines) => lines[lineIdx] ?? "")))
    }
  }

  return out
}

/** 输入区布局：把输入缓冲折行，同时算出光标的 (行, 列) 位置（显示宽度） */
export function layoutInput(chars, cursor, width) {
  const PROMPT = "▸ "
  const lines = []
  let cursorLine = 0
  let cursorCol = 0
  let cur = ""
  let col = 0
  let firstLine = true
  const avail = () => (firstLine ? width - 2 : width)
  const flush = () => {
    lines.push((firstLine ? PROMPT : "") + cur)
    firstLine = false
    cur = ""
    col = 0
  }
  for (let i = 0; i <= chars.length; i++) {
    if (i === cursor) {
      cursorLine = lines.length
      cursorCol = (firstLine ? 2 : 0) + col
    }
    const ch = chars[i]
    if (ch === undefined) break
    if (ch === "\n") {
      flush()
      continue
    }
    const w = charWidth(ch.codePointAt(0))
    if (col + w > avail()) flush()
    cur += ch
    col += w
  }
  if (cur || lines.length === 0) flush()
  return { lines, cursorLine, cursorCol }
}

/** 文本按宽度折行（保留 \n），返回行数组 */
/**
 * 显示净化：控制字符会破坏终端网格数学（\r 回车覆盖、\t 宽度误判致整帧错位、ANSI/响铃冲屏）。
 * 只动显示层——模型看到的工具结果原文不变；session 里已存的脏 display 回放时也经此净化。
 */
const ANSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g
export function sanitizeDisplay(s) {
  return s
    .replace(ANSI_SEQUENCE_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n+$/, "")
}

export function wrapText(text, width) {
  const lines = []
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      lines.push("")
      continue
    }
    let line = rawLine
    while (stringWidth(line) > width) {
      const head = sliceByWidth(line, width)
      lines.push(head)
      line = line.slice([...head].length)
    }
    lines.push(line)
  }
  return lines
}

// ---------------------------------------------------------------- TUI 主入口

/**
 * 启动 TUI，接管终端直到退出。
 * agent: createAgent 的返回值
 * opts: { projectDir?, team?, author? } —— /distill 写入 project/team 层时用
 */
export async function startTUI(agent, opts = {}) {
  if (!process.stdin.isTTY) {
    throw new Error("TUI requires a TTY; use 'thincoder chat' for non-interactive use")
  }

  const distillOpts = opts

  const state = {
    lines: [], // 对话区行：{ text, color }
    streaming: "", // 当前流式缓冲
    input: [], // 输入缓冲区（码点数组）
    cursor: 0,
    history: [],
    historyIndex: -1,
    scroll: 0, // 从底部向上的滚动行数
    processing: false,
    controller: null, // AbortController for current agent run
    permission: null, // { name, args, resolve }
    permissionPreview: [], // 权限审批的内容预览行（渲染在输入框上方，不分隔）
    question: null, // { text, options, resolve } — agent 的 question 工具回调
    picker: null, // 模型选择器 { entries, lines, index, scroll, selectedLine }
    wizard: null, // 首次配置向导 { step, index, scroll, selectedLine, fields, error, lines }
    tasks: agent.tasks ?? [], // task 工具的任务列表（状态栏显示进度）；会话恢复时直接带上，全完成自动收起
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }, // 累计 token 用量（状态栏显示）
    ctxCache: { len: -1, tokens: 0 }, // 上下文占用估算缓存（estimateTokens 是 O(n)，history 变长才重算）
    reasoning: "", // 思考流缓冲（暗色展示）
    completion: null, // Tab 补全状态 { candidates, index }
    toolStreams: {}, // 各工具的实时输出（按工具名隔离，并行工具互不串扰）
    subOutput: "", // 子 agent 流式输出（滚动显示，最长保留末尾 300 字符）
    currentSub: null, // 当前活跃的子 agent 角色名
    currentTool: null, // 正在执行的工具名（状态栏显示）
    processingStarted: 0, // 本轮处理开始时间（状态栏计时）
    status: "Ready",
  }

  // 恢复的会话如果所有任务已完成，自动收起 todo 面板（对齐运行时行为）
  if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
    state.tasks = []
  }

  // 输入流先过一道滤网：鼠标序列（滚轮）在这里拦截处理，剥净后才交给 keypress 解析，
  // 防止序列残片（如 "64;72;42M"）漏进输入框
  const keyStream = new PassThrough()
  let mousePending = "" // 跨 chunk 的不完整鼠标序列尾部
  let lastRenderedScroll = 0
  emitKeypressEvents(keyStream)
  process.stdin.setRawMode(true)
  process.stdout.write(ansi.altBuffer + ansi.hideCursor + ansi.mouseOn)

  process.stdin.on("data", (chunk) => {
    let text = mousePending + chunk.toString("utf8")
    mousePending = ""

    // 滚轮：\x1b[<64;…M 上滚，\x1b[<65;…M 下滚（每次 3 行）
    for (const m of text.matchAll(/\x1b\[<(\d+);\d+;\d+([Mm])/g)) {
      if (Number(m[1]) === 64) {
        state.scroll += 3
      } else if (Number(m[1]) === 65) {
        state.scroll = Math.max(0, state.scroll - 3)
      }
    }

    // 剥掉完整鼠标序列；不完整的尾部留到下一块数据再拼
    text = text.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "")
    const tail = text.match(/\x1b\[<[\d;]*$/)
    if (tail) {
      mousePending = tail[0]
      text = text.slice(0, -tail[0].length)
    }

    if (state.scroll !== lastRenderedScroll) {
      lastRenderedScroll = state.scroll
      render()
    }
    if (text) keyStream.write(text)
  })

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    // 退出前保存会话（同步写）；先归档当前到槽位，再落新——不丢
    try {
      archiveCurrent(agent.cwd)
      saveSession(agent, state.lines)
    } catch {
      // 存失败不耽误退出
    }
    // 关闭 MCP stdio 子进程，不留孤儿
    try {
      closeAllMcp(agent)
    } catch {
      // 关不掉就算了，进程马上退出
    }
    process.stdin.setRawMode(false)
    process.stdout.write(ansi.mouseOff + ansi.mainBuffer + ansi.showCursor + ansi.reset)
  }
  process.on("exit", cleanup)

  const pushLine = (text, color) => {
    state.lines.push({ text, color })
    if (state.lines.length > 5000) state.lines.splice(0, 1000) // 防无限增长
    render()
  }

  /** 消息块标签：空行 + 标签行。用户/助手消息之间留出呼吸空间 */
  const pushLabel = (text, color) => {
    if (state.lines.length > 0) state.lines.push({ text: "", color: C.dim })
    state.lines.push({ text, color })
    render()
  }

  // 每轮对话只打一次助手标签（首个 token 或首个工具调用时）
  let assistantLabeled = false
  const ensureAssistantLabel = () => {
    if (!assistantLabeled) {
      assistantLabeled = true
      pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
    }
  }

  // ---------------------------------------------------------- 渲染

  // 帧去重 + 流式限流：内容没变的帧不重写（防闪屏）；token 洪流合并到 ~25fps
  let lastFrame = ""
  let renderTimer = null

  /** 流式期间的限流渲染（trailing edge：最后一次变化一定渲染到） */
  function scheduleRender() {
    if (renderTimer) return
    renderTimer = setTimeout(() => {
      renderTimer = null
      render()
    }, 40)
  }

  function render() {
    const cols = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const model = agent.provider.model
    const thinking = agent.provider.thinking
    const effort = agent.provider.reasoningEffort
    const thinkBadge = thinking?.type === "disabled" ? "│ think: off"
      : effort ? `│ think: ${effort}` : thinking?.type === "enabled" ? "│ think: on" : ""

    // 输入区：全边框盒，宽度 W（所有输出行严格 ≤ cols-1，防自动折行错位）
    const W = Math.max(20, cols - 1)
    const layout = layoutInput(state.input, state.cursor, W - 4)
    // 最多显示 5 行；超出时以光标所在行为中心滚动
    const MAX_INPUT_LINES = 5
    let inputOffset = 0
    if (layout.lines.length > MAX_INPUT_LINES) {
      inputOffset = Math.min(layout.cursorLine, layout.lines.length - MAX_INPUT_LINES)
    }
    const inputLines = layout.lines.slice(inputOffset, inputOffset + MAX_INPUT_LINES)
    // question 模式下输入框显示选项/答案草稿，而不是普通输入（高度也要跟着走）
    let boxLines = inputLines
    if (state.question) {
      const q = state.question
      boxLines = q.options.length > 0
        ? q.options.map((opt, i) => (i === (q.selected ?? 0) ? "▸ " : "  ") + opt)
        : ["▸ " + (q.answer ?? "")]
    }
    const inputBoxH = boxLines.length + 2

    const headerH = 1
    const statusH = 1
    // 浮层（模型选择器 / 初始配置向导）打开时，在对话区下方预留一块（标题 + 列表窗口）
    const overlay = state.picker ?? state.wizard
    const pickerH = overlay
      ? Math.min(overlay.lines.length + 1, Math.max(6, rows - 12))
      : 0
    // todo 面板：有任务列表时占对话区与输入框之间最多 5 行
    // 折叠时优先 in_progress，兼顾最早的 pending 和最近的 done
    const MAX_TASK_LINES = 5
    let visibleTasks = []
    if (state.tasks.length <= MAX_TASK_LINES) {
      visibleTasks = state.tasks
    } else {
      const inProgress = state.tasks.filter((t) => t.status === "in_progress")
      const pending = state.tasks.filter((t) => t.status === "pending")
      const done = state.tasks.filter((t) => t.status === "done")
      visibleTasks = [...inProgress, ...pending, ...done].slice(0, MAX_TASK_LINES)
    }
    const taskPanelH = visibleTasks.length
    // 子 agent 流式输出占位（显示时占最多 2 行）
    const subOutLen = (state.subOutput && state.processing) ? wrapText(state.subOutput, W - 8).slice(-2).length : 0
    // 权限预览占位
    const permPreviewLen = state.permission ? 1 + state.permissionPreview.reduce((s, l) => s + wrapText(`  ${l}`, W - 1).length, 0) : 0
    const convH = Math.max(1, rows - headerH - inputBoxH - statusH - pickerH - taskPanelH - subOutLen - permPreviewLen)

    // 对话区内容行（含流式缓冲）；markdown 表格先按显示宽度重排
    const convLines = []
    for (const l of state.lines) {
      for (const line of formatTables(sanitizeDisplay(l.text), cols - 1)) {
        for (const wrapped of wrapText(line, cols - 1)) {
          convLines.push({ text: wrapped, color: l.color })
        }
      }
    }
    // 思考流（暗色）在正文流之前
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
    // 工具实时输出（暗色，只保留末尾防刷屏；按工具名隔离防止并行工具串扰）
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

    // header（超宽截断，防终端折行）
    out.push(
      `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${sliceByWidth(model, 30)}${thinkBadge ? " " + thinkBadge : ""} │ ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 60))}${ansi.reset}${ansi.clearLine}`,
    )

    // 对话区（不足部分补空行，把输入框钉在底部）
    const pad = convH - visible.length
    for (let i = 0; i < pad; i++) out.push(ansi.clearLine)
    for (const l of visible) {
      out.push(`${l.color}${l.text}${ansi.reset}${ansi.clearLine}`)
    }

    // 浮层（模型选择器 / 初始配置向导）：列表滚动跟随选中行
    if (overlay) {
      const winH = pickerH - 1
      if (overlay.selectedLine < overlay.scroll) overlay.scroll = overlay.selectedLine
      if (overlay.selectedLine >= overlay.scroll + winH) overlay.scroll = overlay.selectedLine - winH + 1
      const start = Math.max(0, Math.min(overlay.scroll, Math.max(0, overlay.lines.length - winH)))
      const shown = overlay.lines.slice(start, start + winH)
      const overlayTitle = state.picker ? " ❯ 选择模型 " : " ❯ 初始配置 "
      out.push(`${ansi.bold}${C.tool}${overlayTitle}${ansi.reset}${ansi.dim}${state.picker ? "(↑↓ 移动, Enter 确认, Esc 取消)" : ""}${ansi.reset}${ansi.clearLine}`)
      for (const l of shown) {
        out.push(`${l.color}${sliceByWidth(l.text, cols - 1)}${ansi.reset}${ansi.clearLine}`)
      }
      for (let i = shown.length; i < winH; i++) out.push(ansi.clearLine)
    }

    // todo 面板（对话区与输入框之间）：▶ in_progress / ✓ done(删除线) / ○ pending
    for (const t of visibleTasks) {
      const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
      const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text
      out.push(`${color} ${mark} ${sliceByWidth(t.title, cols - 4)}${ansi.reset}${ansi.clearLine}`)
    }

    // 子 agent 流式输出（最多 2 行，滚动显示最新内容）
    if (state.subOutput && state.processing) {
      const lines = wrapText(state.subOutput, W - 8)
      const tail = lines.slice(-2)
      for (const l of tail) {
        out.push(`${C.dim}[${state.currentSub}] ${l}${ansi.reset}${ansi.clearLine}`)
      }
    }

    // 权限审批内容预览（黄色，紧挨输入框上方）
    if (state.permission) {
      out.push(`${ansi.bold}${C.warn}❯ 权限请求${ansi.reset}${ansi.clearLine}`)
      for (const line of state.permissionPreview) {
        for (const wrapped of wrapText(`  ${line}`, W - 1)) {
          out.push(`${C.warn}${wrapped}${ansi.reset}${ansi.clearLine}`)
        }
      }
    }

    // 输入框（全边框，宽 W）
    let borderColor = C.tool
    let title
    if (state.question) {
      borderColor = C.tool
      title = ` ${sliceByWidth(state.question.text, W - 6)} `
    } else if (state.permission) {
      borderColor = C.warn
      if (state.permission.name === "continue") {
        title = " Continue? (y/n) "
      } else {
        title = ` Allow ${state.permission.name}? (y/n/a) `
      }
    } else if (state.picker) {
      title = " Model "
    } else if (state.wizard) {
      title = " Setup "
    } else if (state.processing) {
      title = " Processing... "
    } else {
      title = " Input "
    }
    const topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 3 - stringWidth(title)))}╮`
    out.push(`${borderColor}${topBorder}${ansi.reset}${ansi.clearLine}`)
    for (const l of boxLines) {
      const content = sliceByWidth(l, W - 4)
      const fill = " ".repeat(Math.max(0, W - 4 - stringWidth(content)))
      out.push(`${borderColor}│${ansi.reset} ${content}${fill} ${borderColor}│${ansi.reset}${ansi.clearLine}`)
    }
    out.push(`${borderColor}╰${"─".repeat(Math.max(0, W - 2))}╯${ansi.reset}${ansi.clearLine}`)

    // 状态栏（输入 / 开头时变为命令提示）
    const scrollHint = state.scroll > 0 ? ` │ scrolled ${state.scroll}` : ""
    const rawInput = state.input.join("")
    let statusLine
    if (state.question) {
      const q = state.question
      statusLine = q.options.length > 0
        ? " ↑↓: 选择 │ Enter: 确认 │ Esc: 取消"
        : " 输入回答后 Enter 提交 │ Esc: 取消"
    } else if (state.permission) {
      statusLine = state.permission.name === "continue"
        ? " y: 继续 │ n: 停止"
        : " y: 批准 │ n: 拒绝 │ a: 批准并全部放行（AUTO）"
    } else if (state.picker) {
      statusLine = " ↑↓: 选择 │ Enter: 确认 │ Esc: 取消"
    } else if (state.wizard) {
      statusLine = state.wizard.step === "provider"
        ? " ↑↓: 选择 │ Enter: 确认 │ Esc: 跳过"
        : " 输入后 Enter 确认 │ Esc: 取消"
    } else if (rawInput.startsWith("/") && !state.processing && !state.permission) {
      const [cmd, sub] = rawInput.split(/\s+/)
      const cmds = SLASH_COMMANDS.filter((c) => c.name.startsWith(cmd))
      const match = cmds.length === 1 ? cmds[0] : null
      if (match?.name === "/config" && cmd === "/config") {
        statusLine = " /config 查看  │  embedkey 配 embedding  │  set 改参数"
      } else if (match?.name === "/provider" && cmd === "/provider") {
        statusLine = " /provider 列表  │  add / remove / key"
      } else if (match?.name === "/model" && cmd === "/model" && !sub) {
        statusLine = " /model 打开选择器  │  /model <名称> 直接切换"
      } else if (match?.name === "/think" && cmd === "/think") {
        statusLine = " /think 查看  │  on / off 开关  │  effort high / max 强度"
      } else if (cmds.length > 0) {
        if (cmds.length <= 4) {
          statusLine = ` ${cmds.map((c) => `${c.name} ${c.desc}`).join("  │  ")}`
        } else {
          statusLine = ` ${cmds.map((c) => c.name).join("  ")}  │  Tab 补全`
        }
      } else {
        statusLine = ` 未知命令（/help 查看可用命令）`
      }
    } else {
      const taskHint = state.tasks.length > 0
        ? ` │ ✓${state.tasks.filter((t) => t.status === "done").length}/${state.tasks.length}`
        : ""
      // token 用量：↑输入 ↓输出 + 缓存命中率（DeepSeek usage 带 prompt_cache_hit/miss_tokens）
      const tk = state.tokens
      const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
      const cacheTotal = tk.cacheHit + tk.cacheMiss
      const tokenHint = tk.prompt > 0
        ? ` │ ↑${fmtK(tk.prompt)} ↓${fmtK(tk.completion)}${cacheTotal > 0 ? ` hit${Math.round((tk.cacheHit / cacheTotal) * 100)}%` : ""}`
        : ""
      const elapsed = state.processing ? ` ${Math.floor((Date.now() - state.processingStarted) / 1000)}s` : ""
      const toolHint = state.currentTool ? ` ${state.currentTool}…` : ""
      const statusText = state.processing ? `${state.status}${toolHint}${elapsed}` : state.status
      // 上下文利用率：占压缩阈值百分比（到 100% 触发压缩；≥80% 变黄提醒该收尾或 /new）
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
      statusLine = ` ${statusText}${taskHint}${tokenHint}${ctxHint}${scrollHint} │ Enter: send │ /: commands │ wheel/PgUp/PgDn: scroll │ Ctrl+C: exit`
    }
    const autoBanner = agent.autoApprove ? `${C.warn} AUTO${ansi.reset}${ansi.dim}│` : ""
    const planBanner = agent.planMode ? `${C.tool} PLAN${ansi.reset}${ansi.dim}│` : ""
    // 状态栏最多一行：终端宽度扣掉 banner 前缀的可视列数，防折行
    const bannerPrefix = (agent.planMode ? " PLAN│ " : "") + (agent.autoApprove ? " AUTO│ " : "")
    const statusMax = cols - 1 - (bannerPrefix ? stringWidth(bannerPrefix) : 0)
    statusLine = sliceByWidth(statusLine, Math.max(10, statusMax))
    out.push(`${ansi.dim}${planBanner}${autoBanner}${statusLine}${ansi.reset}${ansi.clearLine}`)

    const frame = out.join("\r\n")
    if (frame !== lastFrame) {
      lastFrame = frame
      process.stdout.write(frame)
    }

    // 光标：输入态定位到输入框内（IME 候选框跟随真实光标）；处理中/权限确认/菜单态时隐藏
    if (state.processing || state.permission || state.question || state.picker || state.wizard?.step === "provider") {
      process.stdout.write(ansi.hideCursor)
    } else {
      const cursorRow = 1 + convH + pickerH + taskPanelH + 2 + (layout.cursorLine - inputOffset) // header + 对话区 + todo 面板 + 上边框 + 行偏移
      const cursorCol = 3 + layout.cursorCol // 左边框 + 空格 + 文本偏移（1 基）
      process.stdout.write(`${ESC}[${cursorRow};${cursorCol}H${ansi.showCursor}`)
    }
  }

  process.stdout.on("resize", render)

  // ---------------------------------------------------------- 提交

  async function submit() {
    const text = state.input.join("").trim()
    if (!text || state.processing) return
    state.input = []
    state.cursor = 0
    state.history.push(text)
    state.historyIndex = -1
    state.scroll = 0

    // 斜杠命令：本地处理，不进入 agent
    if (text.startsWith("/")) {
      await handleSlash(text)
      return
    }

    pushLabel(`❯ You:`, ansi.bold + C.user)
    pushLine(text, C.text)

    // 任务开始前自动打存档点（git 仓库内；失败静默，不挡任务）
    try {
      const { createCheckpoint } = await import("./checkpoint.mjs")
      await createCheckpoint(agent.cwd)
    } catch {
      // 存档失败不影响任务
    }

    assistantLabeled = false
    state.processing = true
    state.status = "Processing..."
    state.streaming = ""
    state.reasoning = ""
    state.currentTool = null
    state.processingStarted = Date.now()
    state.controller = new AbortController()
    // 处理中每秒刷新一次状态栏（运行计时）
    const ticker = setInterval(() => {
      if (state.processing) render()
    }, 1000)
    render()

    const callbacks = {
      onToken: (t) => {
        // 子 agent 流式输出：前缀匹配 explore/coder/plan 的 token 进 subOutput
        const subMatch = t.match(/^(explore|coder|plan)\//)
        if (subMatch) {
          state.currentSub = subMatch[1]
          state.subOutput = (state.subOutput + t.slice(subMatch[0].length)).slice(-300)
          scheduleRender()
          return
        }
        ensureAssistantLabel()
        state.streaming += t
        scheduleRender()
      },
      onReasoning: (t) => {
        ensureAssistantLabel()
        state.reasoning += t
        scheduleRender()
      },
      onToolCall: (name, args) => {
        flushStream()
        ensureAssistantLabel()
        state.currentTool = name
        pushLine(`  [tool] ${name} ${summarize(args)}`, C.tool)
      },
      onToolResult: (name, result) => {
        state.currentTool = null
        // 子 agent 结束：清空流式缓冲
        if (name.startsWith("explore/") || name.startsWith("coder/") || name.startsWith("plan/")) {
          state.subOutput = ""
          state.currentSub = null
        }
        const stream = state.toolStreams[name]
        if (stream) {
          const tail = stream.trimEnd().slice(-4000)
          if (tail) pushLine(tail, C.dim)
          delete state.toolStreams[name]
        }
        const first = result.split("\n")[0]
        pushLine(`  [done] ${name} → ${sliceByWidth(first, 100)}`, C.dim)
      },
      onToolOutput: (name, chunk) => {
        state.toolStreams[name] = (state.toolStreams[name] ?? "") + chunk
        scheduleRender()
      },
      onPermissionRequest: (name, args) => askPermission(name, args),
      onQuestion: (text, options) => askQuestion(text, options),
      onCompress: () => {
        pushLine("  [context] 上下文过长，已自动压缩（早期对话由 LLM 摘要，任务状态保留）", C.warn)
      },
      onUsage: (usage) => {
        state.tokens.prompt += usage.prompt_tokens ?? 0
        state.tokens.completion += usage.completion_tokens ?? 0
        state.tokens.cacheHit += usage.prompt_cache_hit_tokens ?? 0
        state.tokens.cacheMiss += usage.prompt_cache_miss_tokens ?? 0
      },
      onTaskUpdate: (items) => {
        state.tasks = items
        const done = items.filter((i) => i.status === "done").length
        // 留痕带上当前任务标题：回看历史时知道进行到哪一项
        const current = items.find((i) => i.status === "in_progress")
        pushLine(`  [task] ${done}/${items.length}${current ? ` ▶ ${current.title}` : ""}`, C.dim)
        render()
      },
      // 增量保存：每 5 个工具 turn 落一次盘，中途崩溃丢失窗口从一整轮缩到几轮
      onTurnEnd: (() => {
        let n = 0
        return () => {
          if (++n % 5 !== 0) return
          try { saveSession(agent, state.lines) } catch {}
        }
      })(),
    }

    for (let resume = false; ; resume = true) {
      try {
        await runAgent(agent, text, callbacks, { signal: state.controller.signal, resume })
        flushStream()
        break // 正常完成，退出循环
      } catch (error) {
        flushStream()
        if (error.name === "AbortError" || state.controller?.signal.aborted) {
          pushLine("[已中止]", C.warn)
          break
        }
        if (error instanceof ContinueError) {
          pushLabel(`❯ Continue`, ansi.bold + C.warn)
          pushLine(`已执行 ${error.turn} 轮（上限 ${error.turn}），要继续吗？`, C.warn)
          // 暂停询问：复用 permission 机制
          const willContinue = await new Promise((resolve) => {
            state.permission = {
              name: "continue",
              args: { turns: error.turn },
              resolve,
            }
            state.status = `Continue after ${error.turn} turns?`
            render()
          })
          state.permission = null
          if (!willContinue) {
            pushLine("[已取消继续]", C.warn)
            break
          }
          pushLine("[继续执行…]", C.tool)
          // 重创新 AbortController：旧 signal 一旦 abort 过，resume 会立即失败（防御性，当前路径不可达但耦合紧）
          state.controller = new AbortController()
          continue
        }
        pushLine(`[error] ${error.message}`, C.error)
        break
      }
    }

    clearInterval(ticker)
    state.processing = false
    state.controller = null
    state.status = "Ready"
    // 全部完成时自动收起 todo 面板（对齐 kimi-code TUI；agent.tasks 本身保留）
    if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
      state.tasks = []
    }
    // 每轮结束后保存会话（崩溃也不丢）
    try {
      saveSession(agent, state.lines)
    } catch {
      // 存失败不打断使用
    }
    render()
  }

  function flushStream() {
    if (state.reasoning) {
      pushLine(state.reasoning, C.reason)
      state.reasoning = ""
    }
    if (state.streaming) {
      pushLine(state.streaming, C.text)
      state.streaming = ""
    }
  }

  function askPermission(name, args) {
    // auto 模式：完全授权，不再询问
    if (agent.autoApprove) {
      pushLine(`  [auto] ${name} ${summarize(args)}`, C.warn)
      return Promise.resolve(true)
    }
    // 预览内容存到 permissionPreview，渲染在输入框上方紧挨"Allow?"提示
    state.permissionPreview = formatPermission(name, args)
    return new Promise((resolve) => {
      state.permission = { name, args, resolve }
      state.status = `Waiting: ${name}`
      render()
    })
  }

  /** 权限请求的关键信息（按工具定制），返回行数组。name 可能带子 agent 前缀（"coder/bash"），取基名匹配 */
  function formatPermission(name, args) {
    const cap = (s, n = 1000) => (s.length > n ? `${s.slice(0, n)}…(共 ${s.length} 字符)` : s)
    const base = name.includes("/") ? name.split("/").pop() : name
    if (base === "bash") return cap(args.command ?? "").split("\n")
    if (base === "write") {
      // 批准写文件必须看得到要写什么：路径 + 内容预览
      return [`${args.path}（写入 ${(args.content ?? "").length} 字符）`, ...cap(args.content ?? "", 1000).split("\n")]
    }
    if (base === "edit") {
      // 简易 diff：- 旧内容 / + 新内容
      return [
        `${args.path}`,
        ...cap(args.old_string ?? "", 500).split("\n").map((l) => `- ${l}`),
        "  ↓",
        ...cap(args.new_string ?? "", 500).split("\n").map((l) => `+ ${l}`),
      ]
    }
    if (base === "delete") return [`${args.path}${args.force ? "（force：跟踪文件也删）" : ""}`]
    if (base === "subagent") return cap(args.task ?? "", 500).split("\n")
    if (base === "memory_put") return [`[${args.type ?? ""}] ${args.title ?? ""}`, ...cap(args.content ?? "", 500).split("\n")]
    return [cap(summarize(args), 300)]
  }

  function askQuestion(text, options = []) {
    // 一次只能问一个：question 是只读工具走并行通道，同批第二个直接驳回，
    // 否则后到的会覆盖 state.question，先到的 Promise 永远悬挂（agent 死等）
    if (state.question) {
      return Promise.resolve("(error: 已有问题在等待回答；请一次只问一个，得到答复后再问下一个)")
    }
    if (!options.length) {
      // 自由文本：打开输入态让用户打字，Enter 提交
      pushLabel(`❯ Question`, ansi.bold + C.tool)
      for (const line of text.split("\n")) pushLine(`  ${line}`, C.text)
      return new Promise((resolve) => {
        state.question = { text, options: [], resolve }
        state.status = "Waiting for answer..."
        render()
      })
    }
    // 选项模式：输入框内显示列表，方向键选，Enter 确认
    pushLabel(`❯ Question`, ansi.bold + C.tool)
    for (const line of text.split("\n")) pushLine(`  ${line}`, C.text)
    return new Promise((resolve) => {
      state.question = { text, options, selected: 0, resolve }
      state.status = "Waiting for choice..."
      render()
    })
  }

  // ---------------------------------------------------------- 斜杠命令

  const SLASH_COMMANDS = [
    { name: "/plan", group: "Agent", desc: "规划模式（先设计、再实现）" },
    { name: "/auto", group: "Agent", desc: "自动授权开关" },
    { name: "/model", group: "Agent", desc: "选择模型" },
    { name: "/goal", group: "Agent", desc: "设置/查看/取消长期目标" },
    { name: "/think", group: "Agent", desc: "思维模式与推理强度" },
    { name: "/skills", group: "Tools", desc: "列出项目技能" },
    { name: "/mcp", group: "Tools", desc: "管理 MCP server" },
    { name: "/provider", group: "Config", desc: "管理 provider（增/删/配 key）" },
    { name: "/config", group: "Config", desc: "配置管理（embedding / agent）" },
    { name: "/reindex", group: "Config", desc: "重建记忆索引" },
    { name: "/new", group: "Session", desc: "新会话（旧会话归档到槽位）" },
    { name: "/session", group: "Session", desc: "列出/切换归档会话" },
    { name: "/clear", group: "Session", desc: "清屏" },
    { name: "/distill", group: "Session", desc: "从会话提取知识" },
    { name: "/rewind", group: "Session", desc: "回滚到存档点" },
    { name: "/exit", group: "Session", desc: "退出" },
    { name: "/help", group: "", desc: "此列表" },
  ]

  async function handleSlash(text) {
    const [cmd, ...rest] = text.split(/\s+/)
    switch (cmd) {
      case "/clear":
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
        pushLine("已开始新会话（旧会话已归档到槽位；/session 可查看）", C.dim)
        return
      case "/exit":
        cleanup()
        setTimeout(() => process.exit(0), 100) // 延迟一拍：fetch 后立刻 exit 在 Windows/Node 24 会触发 libuv 断言
        return
      case "/session": {
        const slotNum = Number(rest[0])
        if (rest.length > 0 && !isNaN(slotNum)) {
          // 切换到指定槽位
          const data = switchToSlot(agent.cwd, slotNum)
          if (!data) {
            pushLine(`槽位 ${slotNum} 不存在`, C.dim)
          } else {
            applySession(agent, data)
            state.lines = data.display.length
              ? data.display.map((l) => ({ text: l.text, color: l.color }))
              : []
            state.tasks = agent.tasks ?? []
            // 切换过来的会话如果任务全完成，自动收起面板
            if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
              state.tasks = []
            }
            pushLabel(`── 已切换到槽位 ${slotNum}（${data.history.length} 条消息）──`, C.warn)
            render()
          }
        } else {
          // 列出所有槽位
          const slots = listSlots(agent.cwd)
          if (slots.length === 0) {
            pushLine("没有归档会话（用 /new 后旧会话会自动归档）", C.dim)
          } else {
            pushLabel(`归档会话（/session <n> 切换）:`, ansi.bold + C.tool)
            for (const s of slots) {
              pushLine(`  槽位 ${s.slot} — ${s.date}`, C.text)
            }
          }
        }
        return
      }
      case "/reindex": {
        const { syncDir, codeSync, docSync } = await import("./memory.mjs")
        pushLine("[reindex] 重建索引...", C.tool)
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
        // 重建代码索引
        pushLine(`  [code] 重建代码索引...`, C.tool)
        const cr = await codeSync(agent.memory, agent.cwd, {
          onProgress: (p) => {
            if (p.phase === "index" && p.current % 20 === 0) {
              pushLine(`    索引中... ${p.current}/${p.total}`, C.dim)
            }
          }
        })
        pushLine(`  code: ${cr.total} 文件，+${cr.updated} ~${cr.skipped} -${cr.removed}`, C.dim)
        // 重建文档索引
        pushLine(`  [doc] 重建文档索引...`, C.tool)
        const dr = await docSync(agent.memory, agent.cwd, {
          onProgress: (p) => {
            if (p.phase === "index" && p.current % 5 === 0) {
              pushLine(`    索引中... ${p.current}/${p.total}`, C.dim)
            }
          }
        })
        pushLine(`  doc: ${dr.total} 文件，+${dr.updated} ~${dr.skipped} -${dr.removed}`, C.dim)
        pushLine(`[reindex] 完成，共 ${total} 条目。向量将在下次搜索时惰性生成。`, C.tool)
        return
      }
      case "/distill":
        await runDistill()
        return
      case "/rewind": {
        const { listCheckpoints, rewind, isGitRepo } = await import("./checkpoint.mjs")
        if (!isGitRepo(agent.cwd)) {
          pushLine("[rewind] 当前目录不是 git 仓库，无法使用存档点", C.error)
          return
        }
        const id = rest[0]
        if (!id) {
          const cps = await listCheckpoints(agent.cwd)
          pushLabel(`❯ Checkpoints`, ansi.bold + C.tool)
          if (cps.length === 0) {
            pushLine("（暂无存档点——每次提交任务前自动创建）", C.dim)
          }
          for (const cp of cps.slice(0, 10)) {
            pushLine(`  ${cp.id}  ${new Date(cp.time).toLocaleString()}  (+${cp.untracked} 个未跟踪文件)`, C.dim)
          }
          pushLine("回滚: /rewind <id>（恢复前会先存当前状态，回滚可逆）", C.dim)
          return
        }
        try {
          const summary = await rewind(agent.cwd, id)
          pushLabel(`❯ Rewind`, ansi.bold + C.warn)
          pushLine(`已回滚到 ${id}：补丁${summary.patchApplied ? "已应用" : "无"}，删除新建文件 ${summary.deleted} 个，还原文件 ${summary.restored} 个`, C.tool)
          pushLine("（当前状态已先存为新存档点，可再次 /rewind 回到刚才）", C.dim)
        } catch (error) {
          pushLine(`[rewind] ${error.message}`, C.error)
        }
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
            ? `规划模式已开启：只读工具受限，先设计方案再实现。再次 /plan 退出。`
            : `规划模式已关闭：可以编辑文件和执行命令了。`,
          agent.planMode ? C.tool : C.dim,
        )
        return
      }
      case "/goal": {
        const sub = rest[0]
        if (sub === "set") {
          const text = rest.slice(1).join(" ")
          if (!text) { pushLine("用法: /goal set <目标描述>（; 分隔完成条件，必须是可机器检查的验证手段）", C.error); return }
          const semi = text.indexOf("；") >= 0 ? "；" : text.indexOf(";") >= 0 ? ";" : null
          const objective = semi ? text.slice(0, semi).trim() : text.trim()
          const criteria = semi ? text.slice(semi + 1).trim() : ""
          agent.goal = { objective, criteria, setAt: Date.now(), status: "active", turnsUsed: 0, _blockTally: null }
          pushLabel(`❯ Goal`, ansi.bold + C.warn)
          pushLine(`目标已设置: ${objective}`, C.tool)
          if (criteria) pushLine(`  完成条件: ${criteria}`, C.dim)
          else pushLine(`  ⚠ 未完成条件——agent 用 goal set 设立时会被要求补上可验证的完成条件`, C.warn)
          return
        }
        if (sub === "cancel") {
          agent.goal = null
          pushLabel(`❯ Goal`, ansi.bold + C.dim)
          pushLine(`目标已取消。`, C.dim)
          return
        }
        if (agent.goal) {
          const statusText = { active: "进行中", complete: "已完成", blocked: "已阻塞" }[agent.goal.status] ?? agent.goal.status
          pushLabel(`❯ Goal`, ansi.bold + C.warn)
          pushLine(`目标: ${agent.goal.objective}`, C.tool)
          if (agent.goal.criteria) pushLine(`  完成条件: ${agent.goal.criteria}`, C.dim)
          pushLine(`  状态: ${statusText ?? "进行中"} │ 已用轮数: ${agent.goal.turnsUsed ?? 0} │ 设置于: ${new Date(agent.goal.setAt).toLocaleString()}`, C.dim)
          pushLine("操作: /goal set <描述> 覆盖 | /goal cancel 取消", C.dim)
        } else {
          pushLabel(`❯ Goal`, ansi.bold + C.dim)
          pushLine("（无活跃目标——/goal set <描述> 设置）", C.dim)
        }
        return
      }
      case "/skills": {
        const { loadSkills } = await import("./skills.mjs")
        const skills = await loadSkills(agent.cwd)
        pushLabel(`❯ Skills`, ansi.bold + C.tool)
        if (skills.length === 0) {
          pushLine("（无项目技能——在 .thincoder/skills/ 下创建 .md 文件即可添加）", C.dim)
        }
        for (const s of skills) {
          pushLine(`  ${s.name}: ${s.description.slice(0, 100)}`, C.dim)
        }
        pushLine("激活: 告诉 agent \"load the <name> skill\"", C.dim)
        return
      }
      case "/mcp": {
        const sub = rest[0]
        // ---- /mcp list — 列出配置的 servers + 连接状态 ----
        if (!sub || sub === "list") {
          const servers = agent.config?.mcp?.servers ?? []
          pushLabel(`❯ MCP Servers`, ansi.bold + C.tool)
          if (servers.length === 0) {
            pushLine("（无 MCP server——使用 /mcp add <name> <command> [args] 添加）", C.dim)
          }
          for (const srv of servers) {
            const connected = agent.tools.some((t) => t._mcpName === srv.name)
            const mark = connected ? "●" : "○"
            const color = connected ? C.tool : C.dim
            const toolCount = agent.tools.filter((t) => t._mcpName === srv.name).length
            const desc = srv.url ? srv.url : `${srv.command} ${(srv.args ?? []).join(" ")}`
            pushLine(`  ${mark} ${srv.name}: ${desc}  (${toolCount} tools)`, color)
          }
          pushLabel(`❯ 操作`, ansi.bold + C.tool)
          pushLine(`/mcp add <name> <command> [args...]    添加 stdio server`, C.dim)
          pushLine(`/mcp url <name> <url> [headers...]     添加 HTTP server`, C.dim)
          pushLine(`/mcp remove <name>                     断开并移除 server`, C.dim)
          pushLine(`/mcp connect <name>                   重连已配置的 server`, C.dim)
          pushLine("配置持久化到 config.json 的 mcp.servers[]", C.dim)
          return
        }
        // ---- /mcp add <name> <command> [args...] (stdio) ----
        if (sub === "add") {
          const args = rest.slice(1)
          if (args.length < 2) {
            pushLine("用法: /mcp add <name> <command> [args...]", C.error)
            pushLine("  例: /mcp add github npx -y @modelcontextprotocol/server-github", C.dim)
            return
          }
          const name = args[0]
          const command = args[1]
          const cmdArgs = args.slice(2)
          const existing = (agent.config?.mcp?.servers ?? []).find((s) => s.name === name)
          if (existing) { pushLine(`[mcp] "${name}" 已存在，用 /mcp remove ${name} 先移除`, C.error); return }
          const srv = { name, command, args: cmdArgs.length > 0 ? cmdArgs : undefined }
          await addAndConnect(srv)
          return
        }
        // ---- /mcp url <name> <url> [key=value...] (HTTP) ----
        if (sub === "url") {
          const args = rest.slice(1)
          if (args.length < 2) {
            pushLine("用法: /mcp url <name> <url> [header=value...]", C.error)
            pushLine("  例: /mcp url myapi https://api.example.com/mcp Authorization=\"Bearer token123\"", C.dim)
            return
          }
          const name = args[0]
          const url = args[1]
          const headerPairs = args.slice(2)
          const existing = (agent.config?.mcp?.servers ?? []).find((s) => s.name === name)
          if (existing) { pushLine(`[mcp] "${name}" 已存在，用 /mcp remove ${name} 先移除`, C.error); return }
          const headers = {}
          for (const pair of headerPairs) {
            const eq = pair.indexOf("=")
            if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, "")
          }
          const srv = { name, url, headers: Object.keys(headers).length > 0 ? headers : undefined }
          await addAndConnect(srv)
          return
        }
        // ---- /mcp remove <name> ----
        if (sub === "remove") {
          const name = rest[1]
          if (!name) { pushLine("用法: /mcp remove <name>", C.error); return }
          const { removeMcpTools } = await import("./mcp.mjs")
          removeMcpTools(agent, name)
          await persistRaw((raw) => { raw.mcp ??= { servers: [] }; raw.mcp.servers = raw.mcp.servers.filter((s) => s.name !== name) })
          if (agent.config?.mcp?.servers) agent.config.mcp.servers = agent.config.mcp.servers.filter((s) => s.name !== name)
          pushLabel(`❯ MCP`, ansi.bold + C.tool)
          pushLine(`${name} 已断开并从配置移除。`, C.tool)
          return
        }
        // ---- /mcp connect <name> — 重连 ----
        if (sub === "connect") {
          const name = rest[1]
          if (!name) { pushLine("用法: /mcp connect <name>", C.error); return }
          const srv = (agent.config?.mcp?.servers ?? []).find((s) => s.name === name)
          if (!srv) { pushLine(`[mcp] "${name}" 未在配置中找到（先用 /mcp add 或 /mcp url）`, C.error); return }
          const { removeMcpTools, connectMcpServer } = await import("./mcp.mjs")
          removeMcpTools(agent, name)
          try {
            pushLine(`[mcp] 重连 ${name}...`, C.dim)
            const tools = await connectMcpServer(srv)
            agent.tools.push(...tools)
            pushLabel(`❯ MCP`, ansi.bold + C.tool)
            pushLine(`${name} 已重连，${tools.length} 个工具可用。`, C.tool)
          } catch (error) {
            pushLine(`[mcp] ${name}: ${error.message}`, C.error)
          }
          return
        }
        pushLine(`未知子命令: ${sub}（/mcp list | add | url | remove | connect）`, C.error)
        return
      }

      // ---- /mcp 共享 helper: 保存配置 + 连接 ----
      async function addAndConnect(srv) {
        await persistRaw((raw) => {
          raw.mcp ??= { servers: [] }
          const entry = { name: srv.name }
          if (srv.url) { entry.url = srv.url; if (srv.headers) entry.headers = srv.headers }
          else { entry.command = srv.command; if (srv.args) entry.args = srv.args }
          raw.mcp.servers.push(entry)
        })
        agent.config ??= {}
        agent.config.mcp ??= { servers: [] }
        agent.config.mcp.servers.push(srv)
        try {
          pushLine(`[mcp] 连接 ${srv.name}...`, C.dim)
          const { connectMcpServer } = await import("./mcp.mjs")
          const tools = await connectMcpServer(srv)
          agent.tools.push(...tools)
          pushLabel(`❯ MCP`, ansi.bold + C.tool)
          const desc = srv.url ? srv.url : `${srv.command} ${(srv.args ?? []).join(" ")}`
          pushLine(`${srv.name} (${desc}) 已连接，${tools.length} 个工具:`, C.tool)
          for (const t of tools) pushLine(`  ${t.name}: ${t.description.slice(0, 100)}`, C.dim)
        } catch (error) {
          pushLine(`[mcp] ${srv.name}: ${error.message}（配置已保存，重启后重试）`, C.error)
        }
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
            ? `AUTO 已开启：所有工具调用（含写文件/bash/子 agent）不再询问，自动执行。长任务专用，/auto 关闭。`
            : `AUTO 已关闭：有副作用的工具调用恢复逐个确认。`,
          agent.autoApprove ? C.warn : C.dim,
        )
        return
      case "/think": {
        const sub = rest[0]
        const cur = agent.provider
        const thinkingEnabled = cur.thinking?.type === "enabled" || cur.thinking?.type === undefined
        // ---- /think（无参）: 查看状态 ----
        if (!sub) {
          pushLabel(`❯ Think`, ansi.bold + C.tool)
          pushLine(`思维模式: ${thinkingEnabled ? "🟢 开启" : "⚫ 关闭"}`, C.dim)
          pushLine(`推理强度: ${cur.reasoningEffort ?? "(未设置)"}`, C.dim)
          pushLine(`切换: /think on | off | effort high | effort max`, C.dim)
          return
        }
        // ---- /think on / off ----
        if (sub === "on" || sub === "off") {
          const enable = sub === "on"
          // 仅用 reasoning_effort 的模型（K3）：不碰 thinking 字段，只设/删 reasoningEffort
          const { specForModel } = await import("./config.mjs")
          const spec = specForModel(cur.model)
          if (spec.thinkApi === "effort") {
            // 仅用 reasoning_effort 的模型（K3 / Qwen）：不碰 thinking 字段
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
          pushLine(`思维模式已${enable ? "开启" : "关闭"}`, C.tool)
          if (enable) pushLine(`推理强度: ${cur.reasoningEffort}`, C.dim)
          return
        }
        // ---- /think effort <level> ----
        if (sub === "effort") {
          const level = rest[1]
          if (!level || !["low", "high", "max"].includes(level)) {
            pushLine("用法: /think effort low | high | max", C.error)
            return
          }
          cur.reasoningEffort = level
          await syncProviderField("reasoningEffort", level)
          pushLabel(`❯ Think`, ansi.bold + C.tool)
          pushLine(`推理强度已设为 ${level}`, C.tool)
          return
        }
        pushLine(`未知参数: ${sub}（可用: on / off / effort / effort high|max）`, C.error)
        return
      }
      case "/model": {
        const arg = rest[0]
        if (!arg) {
          // 打开交互选择器：全部 provider 的全部模型，方向键选择
          pushLabel(`❯ Model`, ansi.bold + C.tool)
          pushLine(`/model <名称>      直接切换 provider 或模型（如 /model deepseek-v4-pro）`, C.dim)
          pushLine(`/provider          管理 provider（添加/删除/配 key）`, C.dim)
          openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
          return
        }
        if (arg === "add" || arg === "--add") {
          pushLine(`添加 provider 已移到 /provider add（/provider 查看全部管理命令）`, C.warn)
          return
        }
        // 一个参数两种含义：先按 provider 名匹配，匹配不到就当模型名改当前 provider
        const { resolveCompactThreshold } = await import("./config.mjs")
        const p = agent.providers.find((pp) => pp.name === arg)
        const newModel = p ? p.model : arg
        let thresholdNote = ""
        if (agent.config?.agent?.compactThresholdAuto) {
          const { value } = resolveCompactThreshold(null, newModel)
          agent.config.agent.compactThreshold = value
          thresholdNote = `，压缩阈值随模型调整为 ${value}`
        }
        if (p) {
          agent.activeProvider = arg
          agent.provider = { ...p }
          // key 的环境变量兜底和 loadConfig 保持一致（提供商专用变量只对同名生效）
          if (!agent.provider.apiKey) {
            const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[arg]
            if (envKey && process.env[envKey]) agent.provider.apiKey = process.env[envKey]
          }
          if (!agent.provider.apiKey) agent.provider.apiKey = process.env.THINCODER_API_KEY
          await persistRaw((raw) => { raw.activeProvider = arg })
          agent.config.activeProvider = arg
          pushLabel(`❯ Model`, ansi.bold + C.tool)
          pushLine(`已切换到 ${arg} / ${p.model}${thresholdNote}（已持久化）`, C.tool)
          if (!agent.provider.apiKey) pushLine(`该 provider 还没配 key: /provider key <apikey>`, C.warn)
        } else {
          const target = agent.providers.find((pp) => pp.name === agent.activeProvider) ?? agent.providers[0]
          if (target) target.model = arg
          agent.provider.model = arg
          await persistRaw((raw) => { raw.providers = agent.providers })
          pushLabel(`❯ Model`, ansi.bold + C.tool)
          pushLine(`已将 ${target?.name ?? agent.activeProvider} 的模型改为 ${arg}${thresholdNote}（已持久化）`, C.tool)
        }
        return
      }
      case "/provider": {
        const sub = rest[0]
        // ---- /provider add <名称> <baseURL> <模型>，或 /provider add <预设> ----
        if (sub === "add") {
          const name = rest[1]
          if (!name) {
            pushLine(`用法: /provider add <名称> <baseURL> <模型>，或 /provider add <预设>（${Object.keys(PRESETS).join(", ")}）`, C.error)
            return
          }
          if (agent.providers.some((p) => p.name === name)) {
            pushLine(`"${name}" 已存在；要重建可先 /provider remove ${name}`, C.warn)
            return
          }
          const preset = PRESETS[name]
          const baseURL = (rest[2] ?? preset?.baseURL)?.replace(/\/+$/, "")
          const model = rest[3] ?? preset?.model
          if (!baseURL || !model) {
            pushLine(`缺少参数: /provider add ${name} <baseURL> <模型>`, C.error)
            if (!preset) pushLine(`（"${name}" 不是预设；预设: ${Object.keys(PRESETS).join(", ")}）`, C.dim)
            return
          }
          if (!/^https?:\/\//.test(baseURL)) { pushLine(`baseURL 应以 http(s):// 开头`, C.error); return }
          agent.providers.push({ name, baseURL, model, ...(preset?.desc ? { desc: preset.desc } : {}) })
          await persistRaw((raw) => { raw.providers = agent.providers })
          pushLabel(`❯ Provider`, ansi.bold + C.tool)
          pushLine(`已添加 ${name}（${baseURL} / ${model}）`, C.tool)
          pushLine(`下一步: /provider key ${name} <apikey> 配 key，/model ${name} 切换`, C.dim)
          return
        }
        // ---- /provider remove <名称> ----
        if (sub === "remove" || sub === "rm") {
          const name = rest[1]
          if (!name) { pushLine("用法: /provider remove <名称>", C.error); return }
          const at = agent.providers.findIndex((p) => p.name === name)
          if (at < 0) { pushLine(`未找到 provider "${name}"`, C.error); return }
          if (name === agent.activeProvider) { pushLine(`"${name}" 正在使用中，先 /model 切换到别的 provider 再删`, C.warn); return }
          agent.providers.splice(at, 1)
          await persistRaw((raw) => { raw.providers = agent.providers })
          pushLabel(`❯ Provider`, ansi.bold + C.tool)
          pushLine(`已删除 ${name}`, C.tool)
          return
        }
        // ---- /provider key [名称] <apikey> ----
        if (sub === "key") {
          let name = agent.activeProvider
          let keyParts = rest.slice(1)
          if (rest[1] && agent.providers.some((p) => p.name === rest[1])) {
            name = rest[1]
            keyParts = rest.slice(2)
          }
          const key = keyParts.join(" ")
          if (!key) { pushLine("用法: /provider key [名称] <apikey>（不填名称配当前 provider）", C.error); return }
          await setProviderKey(name, key)
          return
        }
        if (sub) { pushLine(`未知: ${sub}（/provider add | remove | key）`, C.error); return }
        // ---- /provider（无参）: 列表 ----
        pushLabel(`❯ Providers (${agent.providers.length})`, ansi.bold + C.tool)
        for (const p of agent.providers) {
          const active = p.name === agent.activeProvider
          pushLine(
            `${active ? " ▸" : "  "} ${p.name.padEnd(12)} ${p.model.padEnd(20)} ${p.baseURL}${p.apiKey ? " ●key" : " ○无key"}${active ? " ← 当前" : ""}`,
            active ? C.tool : C.dim,
          )
        }
        pushLabel(`❯ 操作`, ansi.bold + C.tool)
        pushLine(`/provider add <名称|预设> <url> <模型>  添加（预设: ${Object.keys(PRESETS).join(" ")}）`, C.dim)
        pushLine(`/provider remove <名称>                 删除`, C.dim)
        if (!agent.provider.apiKey) pushLine("⚡ /provider key <apikey>  ← 当前 provider 还没配 key", C.warn)
        else pushLine("/provider key [名称] <apikey>           设置/更换 key", C.dim)
        return
      }
      case "/config": {
        const sub = rest[0]
        // ---- /config embedkey <apikey>：embedding 服务的 key ----
        if (sub === "embedkey") {
          const key = rest.slice(1).join(" ")
          if (!key) { pushLine("用法: /config embedkey <apikey>（embedding 服务，默认 SiliconFlow bge-m3）", C.error); return }
          agent.config.embedding ??= {}
          agent.config.embedding.apiKey = key
          await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: key } })
          if (agent.memory) {
            const { createEmbedder } = await import("./embedding.mjs")
            agent.memory.embedder = createEmbedder(agent.config.embedding)
          }
          pushLabel(`❯ Config`, ansi.bold + C.tool)
          pushLine(`embedding key 已保存，向量检索已启用`, C.tool)
          return
        }
        // ---- /config set <path> <value> (高级) ----
        if (sub === "set") {
          const [path, value] = [rest[1], rest.slice(2).join(" ")]
          if (!path || !value) { pushLine("用法: /config set <path> <value>  如 /config set agent.maxTurns 80", C.error); return }
          try {
            const { configPath, loadConfig, saveConfig } = await import("./config.mjs")
            const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
            // 支持 a.b 形式的嵌套 key
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
            pushLine(`已保存: ${path} = ${value}`, C.tool)
          } catch (error) {
            pushLine(`保存失败: ${error.message}`, C.error)
          }
          return
        }
        if (sub) { pushLine(`未知: ${sub}（可用: embedkey / set）`, C.error); return }
        // ---- /config（无参）: 查看 ----
        const { configPath: cp } = await import("./config.mjs")
        pushLabel(`❯ 配置`, ansi.bold + C.tool)
        pushLine(`激活:   ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
        pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
        const ac = agent.config?.agent ?? {}
        const tn = `${ac.compactThreshold ?? 100000}${ac.compactThresholdAuto ? " (auto)" : ""}`
        pushLine(`agent:  maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${tn}`, C.dim)
        pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${agent.config?.embedding?.model ?? ""})` : "disabled（纯 FTS 检索）"}`, C.dim)
        pushLabel(`❯ 管理`, ansi.bold + C.tool)
        pushLine(`/provider            管理 provider（添加/删除/配 key）`, C.dim)
        if (!agent.memory?.embedder) pushLine(`/config embedkey <k>  开启向量检索`, C.dim)
        pushLine(`/config set <k> <v>    修改任意配置项`, C.dim)
        pushLine(`配置文件: ${cp}`, C.dim)
        return
      }
      case "/help": {
        const order = ["Agent", "Session", "Tools", "Config"]
        const byGroup = new Map()
        for (const c of SLASH_COMMANDS) {
          if (!c.group) continue
          if (!byGroup.has(c.group)) byGroup.set(c.group, [])
          byGroup.get(c.group).push(c)
        }
        const maxW = Math.max(...SLASH_COMMANDS.map((c) => c.name.length))
        for (const g of order) {
          const cmds = byGroup.get(g)
          if (!cmds?.length) continue
          byGroup.delete(g)
          pushLabel(`❯ ${g}`, ansi.bold + C.tool)
          for (const c of cmds) pushLine(`  ${c.name.padEnd(maxW + 1)} ${c.desc}`, C.dim)
        }
        for (const [g, cmds] of byGroup) {
          pushLabel(`❯ ${g}`, ansi.bold + C.tool)
          for (const c of cmds) pushLine(`  ${c.name.padEnd(maxW + 1)} ${c.desc}`, C.dim)
        }
        return
      }
      default:
        pushLine(`Unknown command: ${cmd}（/help 查看可用命令）`, C.error)
        return
    }
  }

  function maskKey(key) {
    if (!key) return "(none)"
    if (key.length <= 8) return "***"
    return `${key.slice(0, 5)}…${key.slice(-4)}`
  }

  /** Tab 补全候选：命令名 / 子命令 / provider 名 / 预设名 / think 参数 */
  function completions(input) {
    if (!input.startsWith("/")) return []
    const parts = input.split(/\s+/)
    // 还在敲第一个 token：补命令名
    if (parts.length === 1) {
      return SLASH_COMMANDS.filter((c) => c.name.startsWith(parts[0])).map((c) => c.name)
    }
    const cmd = parts[0]
    const last = parts.at(-1) // 结尾是空格时为 ""，即列出全部候选
    const head = parts.slice(0, -1).join(" ")
    const argIndex = parts.length - 2 // 正在敲第几个参数（0 基）
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
      if (argIndex === 0) return match(["add", "url", "remove", "connect", "list"])
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

  /** 读配置文件 → 修改 → 写回；文件不存在时从空对象开始 */
  async function persistRaw(mutate) {
    const { saveConfig, configPath } = await import("./config.mjs")
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    saveConfig(raw)
  }

  /** 把当前激活 provider 的某个字段同步到 providers 列表并持久化 */
  async function syncProviderField(field, value) {
    const target = agent.providers.find((p) => p.name === agent.activeProvider)
    if (!target) return
    if (value === undefined) delete target[field]
    else target[field] = value
    // 全量写回：raw 里的 providers 顺序/内容可能与运行时列表不一致，逐字段改容易写错位
    await persistRaw((raw) => {
      raw.providers = agent.providers
    })
  }

  // ---------------------------------------------------------- 模型选择器（/model）

  const pickerItems = () => state.picker.entries.filter((e) => e.type === "item")

  /** 按 entries 重建显示行并刷新；高亮选中项、标注当前模型 */
  function renderPickerLines() {
    const p = state.picker
    if (!p) return
    const lines = []
    let row = 0
    let selectedLine = 0
    for (const e of p.entries) {
      if (e.type === "header") {
        lines.push({ text: ` ${e.name}${e.note ? `  ${e.note}` : ""}`, color: ansi.bold + C.tool })
      } else {
        const selected = row === p.index
        if (selected) selectedLine = lines.length
        const current = e.provider === agent.activeProvider && e.model === agent.provider.model
        lines.push({
          text: `${selected ? " ▸ " : "   "}${e.model}${current ? "  ← 当前" : ""}`,
          color: selected ? ansi.bold + C.text : C.dim,
        })
        row++
      }
    }
    p.lines = lines
    p.selectedLine = selectedLine
    render()
  }

  /** 打开选择器：先列出各 provider 已配置的模型，再并发拉取各端点的全部模型展开进去 */
  async function openModelPicker() {
    const entries = []
    for (const p of agent.providers) {
      entries.push({ type: "header", name: p.name, note: `${p.baseURL}${p.apiKey ? "" : "（未配 key）"}  加载中...` })
      entries.push({ type: "item", provider: p.name, model: p.model })
    }
    state.picker = { entries, lines: [], index: 0, scroll: 0, selectedLine: 0 }
    // 默认选中当前在用的模型
    const current = pickerItems().findIndex(
      (e) => e.provider === agent.activeProvider && e.model === agent.provider.model,
    )
    if (current >= 0) state.picker.index = current
    renderPickerLines()

    const { listModels } = await import("./provider.mjs")
    await Promise.all(
      agent.providers.map(async (p) => {
        const header = entries.find((e) => e.type === "header" && e.name === p.name)
        const noteBase = `${p.baseURL}${p.apiKey ? "" : "（未配 key）"}`
        try {
          // key 的环境变量兜底和 loadConfig 保持一致（提供商专用变量只对同名生效）
          const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
          let apiKey = p.apiKey
          if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
          if (!apiKey) apiKey = process.env.THINCODER_API_KEY
          const models = await listModels(
            { baseURL: p.baseURL, apiKey: apiKey ?? "" },
            { signal: AbortSignal.timeout(10000) },
          )
          // 展开到该 provider 已配置模型的后面（去重）
          const at = entries.findIndex((e) => e.type === "item" && e.provider === p.name && e.model === p.model)
          entries.splice(
            at + 1,
            0,
            ...models.filter((m) => m !== p.model).map((m) => ({ type: "item", provider: p.name, model: m })),
          )
          header.note = noteBase
        } catch (error) {
          header.note = `${noteBase}  （拉取失败: ${sliceByWidth(error.message, 60)}）`
        }
        if (state.picker?.entries === entries) renderPickerLines() // 已关闭就不再刷新
      }),
    )
  }

  function closeModelPicker() {
    state.picker = null
    render()
  }

  /** 给指定 provider 写 key（内存 + 配置文件）；若它是当前激活的，同步运行时 */
  async function setProviderKey(name, key) {
    const target = agent.providers.find((p) => p.name === name)
    if (!target) {
      pushLine(`未找到 provider "${name}"`, C.error)
      return
    }
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw((raw) => { raw.providers = agent.providers })
    pushLabel(`❯ Provider`, ansi.bold + C.tool)
    pushLine(`apiKey 已保存到 ${name}`, C.tool)
  }

  // ---------------------------------------------------------- 初始配置向导（首次启动）

  /** 菜单步的候选项：已有 provider（未配 key 的标注）+ 未添加的预设 + 自定义 */
  function wizardProviderItems() {
    const items = []
    for (const p of agent.providers) {
      items.push({ kind: "existing", name: p.name, baseURL: p.baseURL, model: p.model, label: `${p.name}（已添加${p.apiKey ? "" : "，未配 key"}）` })
    }
    for (const [name, p] of Object.entries(PRESETS)) {
      if (!agent.providers.some((x) => x.name === name)) {
        items.push({ kind: "preset", name, baseURL: p.baseURL, model: p.model, label: `${name}（${p.desc}）` })
      }
    }
    items.push({ kind: "custom", name: null, label: "自定义端点…" })
    return items
  }

  /** 文本步骤定义：提示语 + 校验（通过返回 true，否则返回错误文案） */
  const WIZARD_STEPS = {
    name: {
      prompt: "给这个 provider 起个名字（字母/数字/-/_，如 my-openai）",
      validate: (v) =>
        (/^[\w-]+$/.test(v) && !agent.providers.some((p) => p.name === v)) || "名字需为字母/数字/-/_，且不与已有 provider 重名",
    },
    baseURL: {
      prompt: "输入 baseURL（如 https://api.openai.com/v1）",
      validate: (v) => /^https?:\/\/.+/.test(v) || "baseURL 应以 http(s):// 开头",
    },
    model: {
      prompt: "输入模型名（如 gpt-4o）",
      validate: (v) => v.length > 0 || "模型名不能为空",
    },
    key: {
      prompt: "输入 API key",
      validate: (v) => v.length > 0 || "key 不能为空",
    },
    embedkey: {
      prompt: "可选：embedding API key（SiliconFlow，记忆向量检索用；直接回车跳过）",
      validate: () => true, // 可跳过
    },
  }
  const WIZARD_NEXT = { name: "baseURL", baseURL: "model", model: "key", key: "embedkey", embedkey: null }

  function startWizard() {
    state.wizard = { step: "provider", index: 0, scroll: 0, selectedLine: 0, fields: {}, error: null, lines: [] }
    renderWizard()
  }

  function renderWizard() {
    const w = state.wizard
    if (!w) return
    const lines = []
    if (w.step === "provider") {
      lines.push({ text: " 选择一个模型提供商：", color: C.text })
      wizardProviderItems().forEach((it, i) => {
        if (i === w.index) w.selectedLine = lines.length
        lines.push({
          text: `${i === w.index ? " ▸ " : "   "}${it.label}`,
          color: i === w.index ? ansi.bold + C.text : C.dim,
        })
      })
    } else {
      const f = w.fields
      if (f.name) lines.push({ text: ` 提供商:  ${f.name}`, color: C.dim })
      if (f.baseURL) lines.push({ text: ` baseURL: ${f.baseURL}`, color: C.dim })
      if (f.model) lines.push({ text: ` 模型:    ${f.model}`, color: C.dim })
      lines.push({ text: ` ❯ ${WIZARD_STEPS[w.step].prompt}`, color: ansi.bold + C.text })
      lines.push({ text: " （在下方输入框输入）", color: C.dim })
      w.selectedLine = 0
    }
    if (w.error) lines.push({ text: ` ${w.error}`, color: C.error })
    w.lines = lines
    render()
  }

  function wizardChooseProvider(item) {
    const w = state.wizard
    if (item.kind === "custom") {
      w.step = "name"
    } else {
      w.fields = { name: item.name, baseURL: item.baseURL, model: item.model }
      w.step = "key"
    }
    renderWizard()
  }

  function wizardSubmitText() {
    const w = state.wizard
    const value = state.input.join("").trim()
    const ok = WIZARD_STEPS[w.step].validate(value)
    if (ok !== true) {
      w.error = ok
      renderWizard()
      return
    }
    w.error = null
    state.input = []
    state.cursor = 0
    w.fields[w.step === "key" ? "key" : w.step] = w.step === "baseURL" ? value.replace(/\/+$/, "") : value
    const next = WIZARD_NEXT[w.step]
    if (next) {
      w.step = next
      renderWizard()
    } else {
      finishWizard().catch((e) => pushLine(`[error] ${e.message}`, C.error))
    }
  }

  function cancelWizard() {
    state.wizard = null
    pushLine("已跳过初始配置。之后随时可用 /provider add 添加提供商、/provider key 配 key。", C.dim)
    render()
  }

  /** 向导完成：写入 provider（有则更新）、设为激活、持久化，然后接模型选择器 */
  async function finishWizard() {
    const f = state.wizard.fields
    state.wizard = null
    const existing = agent.providers.find((p) => p.name === f.name)
    if (existing) Object.assign(existing, { baseURL: f.baseURL, model: f.model, apiKey: f.key })
    else agent.providers.push({ name: f.name, baseURL: f.baseURL, model: f.model, apiKey: f.key })
    agent.activeProvider = f.name
    agent.provider = { ...agent.providers.find((p) => p.name === f.name) }
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("./config.mjs")
      agent.config.agent.compactThreshold = resolveCompactThreshold(null, f.model).value
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = f.name
    })
    agent.config.activeProvider = f.name
    pushLabel(`❯ Setup`, ansi.bold + C.tool)
    pushLine(`配置完成：${f.name} / ${f.model}（已写入配置文件）`, C.tool)
    // embedding key：配了就启用向量检索，没配提示事后通道
    if (f.embedkey) {
      agent.config.embedding ??= {}
      agent.config.embedding.apiKey = f.embedkey
      await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: f.embedkey } })
      if (agent.memory && !agent.memory.embedder) {
        const { createEmbedder } = await import("./embedding.mjs")
        agent.memory.embedder = createEmbedder(agent.config.embedding)
      }
      pushLine(`向量检索已启用（${agent.config.embedding.model ?? "BAAI/bge-m3"}）`, C.tool)
    } else {
      pushLine(`向量检索未启用（记忆退化为纯文本检索）；之后可 /config embedkey <key> 开启`, C.dim)
    }
    pushLine(`选择要用的模型（Esc 保持 ${f.model}）`, C.dim)
    openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
  }

  /** 选中：切换 provider + 模型，持久化，阈值随模型走 */
  async function selectModel(item) {
    closeModelPicker()
    const target = agent.providers.find((pp) => pp.name === item.provider)
    if (!target) return
    target.model = item.model
    agent.activeProvider = item.provider
    agent.provider = { ...target }
    if (!agent.provider.apiKey) {
      const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[item.provider]
      if (envKey && process.env[envKey]) agent.provider.apiKey = process.env[envKey]
    }
    if (!agent.provider.apiKey) agent.provider.apiKey = process.env.THINCODER_API_KEY
    let thresholdNote = ""
    if (agent.config?.agent?.compactThresholdAuto) {
      const { resolveCompactThreshold } = await import("./config.mjs")
      const { value } = resolveCompactThreshold(null, item.model)
      agent.config.agent.compactThreshold = value
      thresholdNote = `，压缩阈值随模型调整为 ${value}`
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = item.provider
    })
    agent.config.activeProvider = item.provider
    pushLabel(`❯ Model`, ansi.bold + C.tool)
    pushLine(`已切换到 ${item.provider} / ${item.model}${thresholdNote}（已持久化）`, C.tool)
    if (!agent.provider.apiKey) pushLine(`该 provider 还没配 key: /config key <apikey>`, C.warn)
  }

  /** /distill：从当前会话提取候选，逐条 y/n 确认后入库 */
  async function runDistill() {
    if (agent.history.length === 0) {
      pushLine("[distill] 当前会话为空，没有可提取的内容", C.dim)
      return
    }
    state.processing = true
    state.status = "Distilling..."
    render()
    try {
      const { extractCandidates, historyToTranscript, saveCandidate } = await import("./distill.mjs")
      pushLine("[distill] 正在分析会话...", C.tool)
      const candidates = await extractCandidates(agent.provider, historyToTranscript(agent.history))
      if (candidates.length === 0) {
        pushLine("[distill] 本次会话没有值得沉淀的知识", C.dim)
        return
      }
      let saved = 0
      for (const c of candidates) {
        pushLine(`── 候选 [${c.type}] ${c.title} (scope: ${c.scope ?? "personal"})`, C.warn)
        for (const line of c.content.split("\n").slice(0, 6)) pushLine(`   ${line}`, C.dim)
        if (c.type === "rule") pushLine("   (rule 类建议手动撰写；确认提取请按 y)", C.warn)
        const accept = await askPermission("distill-save", { title: c.title })
        if (!accept) {
          pushLine("   skipped", C.dim)
          continue
        }
        const where = await saveCandidate(agent.memory, c, distillOpts)
        pushLine(`   saved -> ${where}`, C.tool)
        saved++
      }
      pushLine(`[distill] 完成：入库 ${saved}/${candidates.length} 条`, C.tool)
    } catch (error) {
      pushLine(`[distill] error: ${error.message}`, C.error)
    } finally {
      state.processing = false
      state.status = "Ready"
      render()
    }
  }

  // ---------------------------------------------------------- 键盘 / 鼠标

  // keypress 挂在过滤后的 keyStream 上：鼠标序列已在上游滤网中处理并剥除
  keyStream.on("keypress", (str, key = {}) => {
    // 权限确认态：y 批准 / n 拒绝 / a 批准并开启 AUTO（后续不再询问）
    if (state.permission) {
      const answer = (str || "").toLowerCase()
      const isContinue = state.permission.name === "continue"
      const validKeys = isContinue ? ["y", "n"] : ["y", "n", "a"]
      if (validKeys.includes(answer) || key.name === "escape") {
        const { resolve, name } = state.permission
        state.permission = null
        state.permissionPreview = []
        state.status = "Processing..."
        if (answer === "a" && !isContinue) {
          agent.autoApprove = true
          agent._pendingReminders = agent._pendingReminders ?? []
          agent._pendingReminders.push("[System reminder: AUTO mode is now ON. All tool calls are automatically approved. Use /auto to disable.]")
          pushLine(`  [auto] AUTO 已开启：后续工具调用不再询问（/auto 关闭）`, C.warn)
        }
        const approved = answer === "y" || (answer === "a" && !isContinue)
        // 决定落痕：对话区留下批准/拒绝记录（continue 询问有自己的输出，不重复记）
        if (!isContinue) {
          pushLine(`  [${approved ? "approved" : "denied"}] ${name}`, approved ? C.dim : C.error)
        }
        resolve(approved)
        render()
      }
      return
    }

    // question 工具回调：自由文本 / 选项选择
    if (state.question) {
      const q = state.question
      if (q.options.length > 0) {
        // 选项模式：↑↓ 选择，Enter 确认，Esc 取消
        if (key.name === "escape") {
          q.resolve("(cancelled)")
          state.question = null
          state.status = "Processing..."
          render()
        } else if (key.name === "up") {
          q.selected = Math.max(0, (q.selected ?? 0) - 1)
          render()
        } else if (key.name === "down") {
          q.selected = Math.min(q.options.length - 1, (q.selected ?? 0) + 1)
          render()
        } else if (key.name === "return") {
          const answer = q.options[q.selected ?? 0]
          q.resolve(answer)
          state.question = null
          state.status = "Processing..."
          pushLine(`  → ${answer}`, C.tool)
          render()
        }
      } else {
        // 自由文本：键入答案，Enter 提交，Esc 取消
        if (key.name === "escape") {
          q.resolve("(cancelled)")
          state.question = null
          state.status = "Processing..."
          render()
        } else if (key.name === "return") {
          const answer = (q.answer ?? "").trim()
          q.resolve(answer || "(empty answer)")
          state.question = null
          state.status = "Processing..."
          pushLine(`  → ${answer || "(empty)"}`, C.tool)
          render()
        } else if (key.name === "backspace") {
          q.answer = (q.answer ?? "").slice(0, -1)
          render()
        } else if (str && !key.ctrl && !key.meta) {
          q.answer = (q.answer ?? "") + str
          render()
        }
      }
      return
    }

    if (key.ctrl && key.name === "c") {
      if (state.processing && state.controller) {
        state.controller.abort()
        pushLine("[中止中…]", C.warn)
        render()
        return
      }
      cleanup()
      setTimeout(() => process.exit(0), 100)
    }

    // 模型选择器：↑↓ 移动，Enter 确认，Esc 取消，其余按键吞掉
    if (state.picker) {
      const items = pickerItems()
      if (key.name === "escape") {
        closeModelPicker()
      } else if (key.name === "up" && items.length) {
        state.picker.index = (state.picker.index - 1 + items.length) % items.length
        renderPickerLines()
      } else if (key.name === "down" && items.length) {
        state.picker.index = (state.picker.index + 1) % items.length
        renderPickerLines()
      } else if (key.name === "return" && items.length) {
        selectModel(items[state.picker.index]).catch((e) => pushLine(`[error] ${e.message}`, C.error))
      }
      return
    }

    // 初始配置向导：菜单步 ↑↓/Enter/Esc；文本步 Enter 提交、Esc 取消，编辑键落到正常输入
    if (state.wizard) {
      const w = state.wizard
      if (key.name === "escape") {
        cancelWizard()
        return
      }
      if (w.step === "provider") {
        const items = wizardProviderItems()
        if (key.name === "up" && items.length) {
          w.index = (w.index - 1 + items.length) % items.length
          renderWizard()
        } else if (key.name === "down" && items.length) {
          w.index = (w.index + 1) % items.length
          renderWizard()
        } else if (key.name === "return" && items.length) {
          wizardChooseProvider(items[w.index])
        }
        return
      }
      if (key.name === "return") {
        wizardSubmitText()
        return
      }
      // 文本步骤屏蔽翻页/历史，其余编辑键放行到下面的普通输入逻辑
      if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") return
    }

    // 翻页
    if (key.name === "pageup") {
      state.scroll += Math.max(1, (process.stdout.rows || 24) - 8)
      render()
      return
    }
    if (key.name === "pagedown") {
      state.scroll = Math.max(0, state.scroll - Math.max(1, (process.stdout.rows || 24) - 8))
      render()
      return
    }

    if (state.processing) return // 处理中锁定输入

    // Tab：斜杠命令补全（循环候选）；其余输入忽略（\t 会顶破输入框，永不直接插入）
    if (key.name === "tab") {
      handleTab()
      return
    }

    // 输入历史
    if (key.name === "up") {
      if (state.history.length) {
        state.historyIndex = state.historyIndex === -1 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1)
        state.input = [...state.history[state.historyIndex]]
        state.cursor = state.input.length
        render()
      }
      return
    }
    if (key.name === "down") {
      if (state.historyIndex !== -1) {
        state.historyIndex++
        if (state.historyIndex >= state.history.length) {
          state.historyIndex = -1
          state.input = []
        } else {
          state.input = [...state.history[state.historyIndex]]
        }
        state.cursor = state.input.length
        render()
      }
      return
    }

    // 光标移动
    if (key.name === "left") {
      state.cursor = Math.max(0, state.cursor - 1)
      render()
      return
    }
    if (key.name === "right") {
      state.cursor = Math.min(state.input.length, state.cursor + 1)
      render()
      return
    }
    if (key.name === "home") {
      state.cursor = 0
      render()
      return
    }
    if (key.name === "end") {
      state.cursor = state.input.length
      render()
      return
    }

    // 编辑
    if (key.name === "backspace") {
      if (state.cursor > 0) {
        state.input.splice(state.cursor - 1, 1)
        state.cursor--
        render()
      }
      return
    }
    if (key.name === "delete") {
      if (state.cursor < state.input.length) {
        state.input.splice(state.cursor, 1)
        render()
      }
      return
    }
    if (key.name === "return") {
      submit()
      return
    }

    // 可打印字符 / 粘贴（str 可能一次多个字符）；Tab 一律转成两个空格（\t 显示宽度不定，会顶破输入框）
    // \r\n 在 Windows raw mode 下可能漏进来冲乱页面
    if (str && !key.ctrl && !key.meta) {
      const chars = [...str.replace(/[\r\n]+/g, "").replace(/\t/g, "  ")]
      state.input.splice(state.cursor, 0, ...chars)
      state.cursor += chars.length
      render()
    }
  })

  // 启动画面
  if (!agent.provider.apiKey) {
    pushLabel(`欢迎使用 ThinCoder！`, ansi.bold + C.tool)
    pushLine("检测到还没配置 API key，进入初始配置（Esc 可随时跳过）", C.text)
    startWizard()
  } else {
    pushLine(`Welcome to ThinCoder. Provider: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
  }
  pushLine(`Tools: ${agent.tools.map((t) => t.name).join(", ")}`, C.dim)
  // 恢复上次会话：重建对话区显示（tool 结果行省略，保持清爽）
  if (opts.restored?.display?.length) {
    // 用户视角的恢复：display 是退出前对话区的原样快照，所见即所得
    state.lines = [...opts.restored.display.map((l) => ({ text: l.text, color: l.color })), ...state.lines]
    pushLabel(`── 已恢复上次会话（退出前原样回放）；/new 开始新会话 ──`, C.warn)
  } else if (opts.restored?.history?.length) {
    for (const m of opts.restored.history) {
      if (m.role === "user") {
        if (typeof m.content === "string" && m.content.startsWith("[System reminder:")) continue
        pushLabel(`❯ You:`, ansi.bold + C.user)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
      } else if (m.role === "assistant") {
        pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
        for (const tc of m.tool_calls ?? []) {
          pushLine(`  [tool] ${tc.function?.name ?? "?"}`, C.tool)
        }
      }
      // tool 角色的结果行省略：调用行已足够还原现场
    }
    pushLabel(`── 已恢复上次会话（${opts.restored.history.length} 条消息）；/new 开始新会话 ──`, C.warn)
  }
  // 有归档槽位时给个提示
  if (listSlots(agent.cwd).length > 0) {
    pushLine("提示：存在归档会话，/session 可查看/切换", C.dim)
  }
  render()

  // 后台索引（进界面后再跑，不阻塞启动）；进度走底部状态栏，不往对话区塞行
  ;(async () => {
    const { codeSync, docSync } = await import("./memory.mjs")
    const cwd = agent.cwd
    let codeFiles = 0, docFiles = 0
    try {
      state.status = "Indexing code..."
      render()
      await codeSync(agent.memory, cwd, {
        onProgress: (p) => {
          if (p.phase === "index" && p.current % 30 === 0) {
            state.status = `Indexing code... ${p.current}/${p.total}`
            render()
          }
        }
      })
      codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
    } catch { /* 不阻塞 */ }
    try {
      state.status = "Indexing docs..."
      render()
      await docSync(agent.memory, cwd, {
        onProgress: (p) => {
          if (p.phase === "index" && p.current % 10 === 0) {
            state.status = `Indexing docs... ${p.current}/${p.total}`
            render()
          }
        }
      })
      docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
    } catch { /* 不阻塞 */ }
    state.status = codeFiles || docFiles
      ? `Ready — idx code ${codeFiles} doc ${docFiles}`
      : "Ready"
    render()
  })()
}

function summarize(obj) {
  const s = JSON.stringify(obj)
  return s.length > 80 ? s.slice(0, 80) + "…" : s
}
