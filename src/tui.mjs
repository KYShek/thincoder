/**
 * tui.mjs — 裸 ANSI 终端 UI
 * 零依赖：raw mode 键盘输入、ANSI 转义渲染、自研宽字符换行。
 * 布局：header / 对话区 (可滚动）/ todo 面板 (有任务时）/ 输入框 / 状态栏。
 */

import { emitKeypressEvents } from "node:readline"
import { PassThrough } from "node:stream"
import { basename } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { runAgent, ContinueError } from "./agent.mjs"
import { estimateTokens } from "./context.mjs"
import { saveSession, clearSession, archiveCurrent, listSlots, switchToSlot, sessionPath } from "./session.mjs"
import { PROVIDER_PRESETS as PRESETS, specForModel } from "./config.mjs"
import { closeAllMcp } from "./mcp.mjs"

// ---------------------------------------------------------------- ANSI 工具

const ESC = "\x1b"
const ansi = {
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  altBuffer: `${ESC}[?1049h`,
  mainBuffer: `${ESC}[?1049l`,
  mouseOn: `${ESC}[?1000h${ESC}[?1006h`, // 基本鼠标 + SGR 扩展坐标 (滚轮上报）
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
  user: ansi.fg(4), // blue (标签）
  assistant: ansi.fg(2), // green (标签）
  text: ansi.fg(7), // white (对话正文）
  reason: `${ESC}[2m${ESC}[3m`, // dim + italic (思考流）
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
 * 识别文本中的 markdown 表格块，按显示宽度重排 (修 CJK 错位）。
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

  // 列宽：先按内容，超宽则从最宽列开始收缩 (收缩到至少 3）
  const widths = Array.from({ length: colCount }, (_, c) =>
    Math.max(3, ...rows.map((r) => stringWidth(r[c] ?? ""))),
  )
  const borders = colCount * 3 + 1 // " │ " 分隔 + 首尾 |
  while (widths.reduce((a, b) => a + b, 0) + borders > width && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest]--
  }

  // 单元格渲染：sliceByWidth 截断 (表头单行），padByWidth 补齐
  const fmtCell = (text, ci) => padByWidth(sliceByWidth(text, widths[ci]), widths[ci])
  const fmtRow = (cells) => "│ " + cells.map((c, i) => fmtCell(c, i)).join(" │ ") + " │"

  // 分隔线
  const separator = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤"

  const out = []
  // 表头：单行截断 (表头通常是短标签，折行不如截断直观）
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

/** 输入区布局：把输入缓冲折行，同时算出光标的 (行, 列) 位置 (显示宽度） */
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

/**
 * 显示净化：控制字符会破坏终端网格数学 (\r 回车覆盖、\t 宽度误判致整帧错位、ANSI/响铃冲屏）。
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

/** 文本按宽度折行 (保留 \n），返回行数组 */
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
    streaming: "", // current流式缓冲
    input: [], // 输入缓冲区 (码点数组）
    cursor: 0,
    history: [],
    historyIndex: -1,
    scroll: 0, // 从底部向上的滚动行数
    processing: false,
    controller: null, // AbortController for current agent run
    permission: null, // { name, args, resolve }
    permissionPreview: [], // 权限审批的内容预览行 (渲染在输入框上方，不分隔）
    question: null, // { text, options, resolve } — agent 的 question 工具回调
    picker: null, // 模型选择器 { entries, lines, index, scroll, selectedLine }
    wizard: null, // 首次Config向导 { step, index, scroll, selectedLine, fields, error, lines }
    tasks: agent.tasks ?? [], // task 工具的任务列表 (状态栏显示进度）；会话恢复时直接带上，全完成自动收起
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }, // 累计 token 用量 (状态栏显示）
    ctxCache: { len: -1, tokens: 0 }, // 上下文占用估算缓存 (estimateTokens 是 O(n)，history 变长才重算）
    reasoning: "", // 思考流缓冲 (暗色展示）
    completion: null, // Tab 补全状态 { candidates, index }
    toolStreams: {}, // 各工具的实时输出 (按工具名隔离，并行工具互不串扰）
    subTasks: {}, // 子 agent 面板：{ roleName: { role, text, done } }，每 role 一行，完成后标记 done 停留片刻
    currentTool: null, // 正在执行的工具名 (状态栏显示）
    processingStarted: 0, // 本轮处理开始时间 (状态栏计时）
    status: "Ready",
    queue: [], // 处理中排队的待执行消息：[{ text }]，处理完自动取下一条
  }

  // 恢复的会话如果所有任务completed，自动收起 todo 面板 (对齐运行时行为）
  if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
    state.tasks = []
  }

  // 输入流先过一道滤网：鼠标序列 (滚轮）在这里拦截处理，剥净后才交给 keypress 解析，
  // 防止序列残片 (如 "64;72;42M"）漏进输入框
  const keyStream = new PassThrough()
  let mousePending = "" // 跨 chunk 的不完整鼠标序列尾部
  let lastRenderedScroll = 0
  emitKeypressEvents(keyStream)
  process.stdin.setRawMode(true)
  process.stdout.write(ansi.altBuffer + ansi.hideCursor + ansi.mouseOn)

  process.stdin.on("data", (chunk) => {
    let text = mousePending + chunk.toString("utf8")
    mousePending = ""

    // 滚轮：\x1b[<64;…M 上滚，\x1b[<65;…M 下滚 (每次 3 行）
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
    // 退出前保存会话 (同步写）；先归档current到槽位，再落新——不丢
    try {
      archiveCurrent(agent.cwd)
      saveSession(agent, state.lines)
    } catch {
      // 存失败不耽误退出
    }
    // Off MCP stdio 子进程，不留孤儿
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
    if (state.lines.length > 5000) state.lines.splice(0, 1000) // 防none限增长
    render()
  }

  /** 消息块标签：空行 + 标签行。用户/助手消息之间留出呼吸空间 */
  const pushLabel = (text, color) => {
    if (state.lines.length > 0) state.lines.push({ text: "", color: C.dim })
    state.lines.push({ text, color })
    render()
  }

  // 每轮对话只打一次助手标签 (首个 token 或首个工具调用时）
  let assistantLabeled = false
  const ensureAssistantLabel = () => {
    if (!assistantLabeled) {
      assistantLabeled = true
      pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
    }
  }

  // ---------------------------------------------------------- 渲染

  // 帧去重 + 流式限流：内容没变的帧不重写 (防闪屏）；token 洪流合并到 ~25fps
  let lastFrame = ""
  let renderTimer = null

  /** 流式期间的限流渲染 (trailing edge：最后一次变化一定渲染到） */
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
    const isMultimodal = specForModel(model).multimodal
    const thinkBadge = thinking?.type === "disabled" ? "│ think: off"
      : effort ? `│ think: ${effort}` : thinking?.type === "enabled" ? "│ think: on" : ""

    // 输入区：全边框盒，宽度 W (所有输出行严格 ≤ cols-1，防自动折行错位）
    const W = Math.max(20, cols - 1)
    const layout = layoutInput(state.input, state.cursor, W - 4)
    // 最多显示 5 行；超出时以光标所在行为中心滚动
    const MAX_INPUT_LINES = 5
    let inputOffset = 0
    if (layout.lines.length > MAX_INPUT_LINES) {
      inputOffset = Math.min(layout.cursorLine, layout.lines.length - MAX_INPUT_LINES)
    }
    const inputLines = layout.lines.slice(inputOffset, inputOffset + MAX_INPUT_LINES)
    // question 模式下输入框显示选项/答案草稿，而不是普通输入 (高度也要跟着走）
    let boxLines = inputLines
    if (state.question) {
      const q = state.question
      if (q.options.length > 0) {
        // 选项窗口：只显示选中项 ±2，选项过多时防输入框none限增高撑破锚定布局
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
    // 浮层 (模型选择器 / 初始Config向导）打开时，在对话区下方预留一块 (标题 + 列表窗口）
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
    // 子 agent 面板 (subTasks）：每活跃子 agent 一行，上方对话区下方，最多 4 行折叠
    const activeSubs = Object.values(state.subTasks).filter((s) => !s.done)
    const subPanelH = Math.min(activeSubs.length, 4)
    const subOutLen = subPanelH
    // 权限预览占位：字符数之外再封顶显示行数 (rows-8），多行短行也能把帧撑过终端高度，破坏锚定布局
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

    // 对话区内容行 (含流式缓冲）；markdown 表格先按显示宽度重排
    const convLines = []
    for (const l of state.lines) {
      for (const line of formatTables(sanitizeDisplay(l.text), cols - 1)) {
        for (const wrapped of wrapText(line, cols - 1)) {
          convLines.push({ text: wrapped, color: l.color })
        }
      }
    }
    // 思考流 (暗色）在正文流之前
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
    // 工具实时输出 (暗色，只保留末尾防刷屏；按工具名隔离防止并行工具串扰）
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

    // header (超宽截断，防终端折行）
    out.push(
      `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${sliceByWidth(model, 30)}${thinkBadge ? " " + thinkBadge : ""} │ ${sliceByWidth(basename(agent.cwd), Math.max(10, cols - 60))}${ansi.reset}${ansi.clearLine}`,
    )

    // 对话区 (不足部分补空行，把输入框钉在底部）
    const pad = convH - visible.length
    for (let i = 0; i < pad; i++) out.push(ansi.clearLine)
    for (const l of visible) {
      out.push(`${l.color}${l.text}${ansi.reset}${ansi.clearLine}`)
    }

    // 浮层 (模型选择器 / 初始Config向导）：列表滚动跟随选中行
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

    // todo 面板 (对话区与输入框之间）：▶ in_progress / ✓ done(删除线) / ○ pending
    for (const t of visibleTasks) {
      const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
      const color = t.status === "done" ? `${C.dim}${ESC}[9m` : t.status === "in_progress" ? C.tool : C.text
      out.push(`${color} ${mark} ${sliceByWidth(t.title, cols - 4)}${ansi.reset}${ansi.clearLine}`)
    }

    // 子 agent 面板：每活跃子 agent 一行，done 的灰色显示后 3 秒自动清除
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

    // 权限审批内容预览 (黄色，紧挨输入框上方）；用上方已封顶的 permPreviewLines，渲染行数与占位一致
    if (state.permission) {
      out.push(`${ansi.bold}${C.warn}❯ 权限请求${ansi.reset}${ansi.clearLine}`)
      for (const wrapped of permPreviewLines) {
        out.push(`${C.warn}${wrapped}${ansi.reset}${ansi.clearLine}`)
      }
    }

    // 队列预览 (暗色，紧挨输入框上方）：与子 agent 面板/权限预览共享输入框上方空间
    // 只在 processing 时显示（非 processing 时队列应为空），且最多 1 行预览避免挤压对话区
    if (state.queue.length > 0 && state.processing) {
      const preview = sliceByWidth(state.queue[0].text, W - 20)
      out.push(`${C.dim}❯ Queue: ${state.queue.length} pending${state.queue.length > 1 ? ` (next: ${preview}…)` : ` (next: ${preview})`} — Ctrl+D del${ansi.reset}${ansi.clearLine}`)
    }

    // 输入框 (全边框，宽 W）
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
      const hint = process.platform === "win32" ? " Alt+V paste " : " Ctrl+V paste "
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

    // 状态栏 (输入 / 开头时变为Commands提示）
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
      const cmds = SLASH_COMMANDS.filter((c) => c.name.startsWith(cmd))
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
      // token 用量：↑输入 ↓输出 + 缓存命中率 (DeepSeek usage 带 prompt_cache_hit/miss_tokens）
      const tk = state.tokens
      const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
      const cacheTotal = tk.cacheHit + tk.cacheMiss
      const tokenHint = tk.prompt > 0
        ? ` │ ↑${fmtK(tk.prompt)} ↓${fmtK(tk.completion)}${cacheTotal > 0 ? ` hit${Math.round((tk.cacheHit / cacheTotal) * 100)}%` : ""}`
        : ""
      const elapsed = state.processing ? ` ${Math.floor((Date.now() - state.processingStarted) / 1000)}s` : ""
      const toolHint = state.currentTool ? ` ${state.currentTool}…` : ""
      const statusText = state.processing ? `${state.status}${toolHint}${elapsed}` : state.status
      // 上下文利用率：占压缩阈值百分比 (到 100% 触发压缩；≥80% 变黄提醒该收尾或 /new）
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

    // 光标：输入态定位到输入框内 (IME 候选框跟随真实光标）；权限确认/菜单态时隐藏
    if (state.permission || state.question || state.picker || state.wizard?.step === "provider") {
      process.stdout.write(ansi.hideCursor)
    } else {
      const cursorRow = 1 + convH + pickerH + taskPanelH + 2 + (layout.cursorLine - inputOffset) // header + 对话区 + todo 面板 + 上边框 + 行偏移
      const cursorCol = 3 + layout.cursorCol // 左边框 + 空格 + 文本偏移 (1 基）
      process.stdout.write(`${ESC}[${cursorRow};${cursorCol}H${ansi.showCursor}`)
    }
  }

  process.stdout.on("resize", render)

  // ---------------------------------------------------------- 提交

  async function submit() {
    const text = state.input.join("").trim()
    if (!text) return
    state.input = []
    state.cursor = 0
    state.history.push(text)
    state.historyIndex = -1
    state.scroll = 0

    // 斜杠Commands：本地处理，不进入 agent
    if (text.startsWith("/")) {
      if (state.processing) {
        // 处理中：只读命令（切换/查看/帮助）直接执行，有副作用的（清屏/新建/重建索引/提取）排队
        const cmd0 = text.split(/\s+/)[0]
        const ALIASES = { "/h": "/help", "/x": "/exit", "/m": "/model", "/p": "/plan", "/t": "/think", "/c": "/clear", "/n": "/new" }
        const resolved0 = ALIASES[cmd0] ?? cmd0
        const safeDuringProcessing = new Set(["/help", "/exit", "/model", "/provider", "/think", "/config", "/skills", "/mcp", "/goal", "/session"])
        if (safeDuringProcessing.has(resolved0)) {
          await handleSlash(text)
        } else {
          state.queue.push({ text })
          render()
        }
        return
      }
      await handleSlash(text)
      return
    }

    // 处理中：入队等待，不立即执行
    if (state.processing) {
      state.queue.push({ text })
      pushLabel(`❯ You: (queued #${state.queue.length})`, ansi.bold + C.user)
      pushLine(text, C.dim)
      render()
      return
    }

    await runAgentTurn(text)
  }

  /** 执行一轮 agent 对话（从 submit 或队列取出调用） */
  async function runAgentTurn(text) {
    pushLine(text, C.text)

    // 任务开始前自动打存档点 (git 仓库内；失败静默，不挡任务）
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
    state.subTasks = {}
    state.currentTool = null
    state.processingStarted = Date.now()
    state.controller = new AbortController()
    // 处理中每秒刷新一次状态栏 (运行计时）
    const ticker = setInterval(() => {
      if (state.processing) render()
    }, 1000)
    render()

    const callbacks = {
      onToken: (t) => {
        // 子 agent 流式输出：前缀匹配 explore/coder/plan/sub 的 token 进 subTasks 面板
        const subMatch = t.match(/^(explore|coder|plan|sub)\//)
        if (subMatch) {
          const role = subMatch[1]
          if (!state.subTasks[role]) state.subTasks[role] = { role, text: "", done: false }
          state.subTasks[role].text = (state.subTasks[role].text + t.slice(subMatch[0].length)).slice(-200)
          scheduleRender()
          return
        }
        ensureAssistantLabel()
        state.streaming += t
        scheduleRender()
      },
      onReasoning: (t) => {
        // 子 agent 的思考 token 同样带 role/ 前缀，进 subTasks 面板，不污染主思考流
        const subMatch = t.match(/^(explore|coder|plan|sub)\//)
        if (subMatch) {
          const role = subMatch[1]
          if (!state.subTasks[role]) state.subTasks[role] = { role, text: "", done: false }
          scheduleRender()
          return
        }
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
        // 子 agent 结束：标记 done，面板保留片刻后清除
        const isSubagent = name === "subagent"
        if (isSubagent) {
          // 所有活跃子 agent 标记 done
          for (const key of Object.keys(state.subTasks)) {
            state.subTasks[key].done = true
          }
          // 子 agent 报告摘要 (最多 8 行）直接展示在对话区
          const lines = result.split("\n")
          const preview = lines.slice(0, 8).map((l) => l.slice(0, 120)).join("\n")
          if (preview) pushLine(preview, C.dim)
          if (lines.length > 8) pushLine(`  ... (${lines.length - 8} more lines)`, C.dim)
          // 3 秒后清除面板中 done 的条目
          setTimeout(() => {
            for (const key of Object.keys(state.subTasks)) {
              if (state.subTasks[key].done) delete state.subTasks[key]
            }
            if (state.processing) render()
          }, 3000)
        }
        const stream = state.toolStreams[name]
        if (stream) {
          const tail = stream.trimEnd().slice(-4000)
          if (tail) pushLine(tail, C.dim)
          delete state.toolStreams[name]
        }
        if (!isSubagent) {
          const first = result.split("\n")[0]
          pushLine(`  [done] ${name} → ${sliceByWidth(first, 100)}`, C.dim)
        }
      },
      onToolOutput: (name, chunk) => {
        state.toolStreams[name] = (state.toolStreams[name] ?? "") + chunk
        scheduleRender()
      },
      onPermissionRequest: (name, args) => askPermission(name, args),
      onQuestion: (text, options) => askQuestion(text, options),
      onCompress: () => {
        pushLine("  [context] Context too long, auto-compacted (early conversation summarized by LLM, task state preserved)", C.warn)
      },
      onUsage: (usage) => {
        state.tokens.prompt += usage.prompt_tokens ?? 0
        state.tokens.completion += usage.completion_tokens ?? 0
        state.tokens.cacheHit += usage.prompt_cache_hit_tokens ?? 0
        state.tokens.cacheMiss += usage.prompt_cache_miss_tokens ?? 0
      },
      // 节流等待 (主动闸门 / 429 退避）：状态栏明示，防用户以为卡死
      onWait: ({ phase, seconds }) => {
        state.status = phase === "gate" ? `TPM 节流等待 ~${seconds}s` : `限流 429，${seconds}s 后重试`
        render()
      },
      onTaskUpdate: (items) => {
        state.tasks = items
        const done = items.filter((i) => i.status === "done").length
        // 留痕带上current任务标题：回看历史时知道进行到哪一项
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
          pushLine("[stopped]", C.warn)
          break
        }
        if (error instanceof ContinueError) {
          pushLabel(`❯ Continue`, ansi.bold + C.warn)
          pushLine(`Ran ${error.turn} turns (limit ${error.turn}). Continue?`, C.warn)
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
            pushLine("[continue cancelled]", C.warn)
            break
          }
          pushLine("[continuing…]", C.tool)
          // 重创新 AbortController：旧 signal 一旦 abort 过，resume 会立即失败 (防御性，current路径不可达但耦合紧）
          state.controller = new AbortController()
          continue
        }
        pushLine(`[error] ${error.message}`, C.error)
        break
      }
    }

    clearInterval(ticker)
    state.processing = false
    state.subTasks = {}
    state.controller = null
    state.status = "Ready"
    // 全部完成时自动收起 todo 面板 (对齐 kimi-code TUI；agent.tasks 本身保留）
    if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
      state.tasks = []
    }
    // 每轮结束后保存会话 (崩溃也不丢）
    try {
      saveSession(agent, state.lines)
    } catch {
      // 存失败不打断使用
    }
    render()

    // 队列里有待执行消息：自动取下一条执行
    if (state.queue.length > 0) {
      const next = state.queue.shift()
      // 队列里的斜杠命令直接执行
      if (next.text.startsWith("/")) {
        await handleSlash(next.text)
        render()
        // 斜杠命令执行完也继续检查队列
        if (state.queue.length > 0 && !state.processing) {
          const next2 = state.queue.shift()
          await runAgentTurn(next2.text)
        }
      } else {
        pushLabel(`❯ You: (from queue)`, ansi.bold + C.user)
        await runAgentTurn(next.text)
      }
    }
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

  /** 权限请求的关键信息 (按工具定制），返回行数组。name 可能带子 agent 前缀 ("coder/bash"），取基名匹配 */
  function formatPermission(name, args) {
    const cap = (s, n = 1000) => (s.length > n ? `${s.slice(0, n)}…(${s.length} chars total)` : s)
    const base = name.includes("/") ? name.split("/").pop() : name
    if (base === "bash") return cap(args.command ?? "").split("\n")
    if (base === "write") {
      // 批准写文件必须看得到要写什么：路径 + 内容预览
      return [`${args.path} (write ${(args.content ?? "").length} chars)`, ...cap(args.content ?? "", 1000).split("\n")]
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
    if (base === "apply_patch") {
      // 补丁本身就是可读的 diff，直接预览
      return cap(args.patch ?? "", 1500).split("\n")
    }
    if (base === "delete") return [`${args.path}${args.force ? " (force: also delete tracked files)" : ""}`]
    if (base === "subagent") return cap(args.task ?? "", 500).split("\n")
    if (base === "memory_put") return [`[${args.type ?? ""}] ${args.title ?? ""}`, ...cap(args.content ?? "", 500).split("\n")]
    return [cap(summarize(args), 300)]
  }

  function askQuestion(text, options = []) {
    // 一次只能问一个：question 是只读工具走并行通道，同批第二个直接驳回，
    // 否则后到的会覆盖 state.question，先到的 Promise 永远悬挂 (agent 死等）
    if (state.question) {
      return Promise.resolve("(error: another question is pending; ask one at a time and wait for the answer)")
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

  /** Ctrl+V / Alt+V：读取剪贴板图片 → 写入工作目录临时文件 → 输入框插入 read_image 命令 */
  async function pasteClipboardImage(agent) {
    const { execFile } = await import("node:child_process")
    const { mkdir, stat, unlink } = await import("node:fs/promises")
    const { join } = await import("node:path")

    const run = (cmd, args) => new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 10000 }, (err, stdout) => { if (err) reject(err); else resolve(stdout) })
    })

    const dest = join(agent.cwd, `.thincoder-paste-${Date.now()}.png`)
    const isWin = process.platform === "win32"
    const isMac = process.platform === "darwin"

    try {
      if (isWin) {
        const psScript = `Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { [System.Windows.Forms.Clipboard]::GetImage().Save('${dest.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`
        await run("powershell", ["-NoProfile", "-Command", psScript])
      } else if (isMac) {
        const script = `try; set f to (POSIX file "${dest}"); set img to the clipboard as «class PNGf»; set fd to open for access f with write permission; write img to fd; close access fd; end try`
        await run("osascript", ["-e", script])
      } else {
        await run("bash", ["-c", `xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null || { which wl-paste >/dev/null 2>&1 && wl-paste -t image/png > "${dest}" 2>/dev/null; } || exit 1`])
      }
    } catch {
      pushLine("Clipboard does not contain an image, or clipboard access failed", C.dim)
      try { await unlink(dest) } catch {}
      return
    }

    const st = await stat(dest).catch(() => null)
    if (!st || st.size === 0) {
      pushLine("Clipboard does not contain an image, or clipboard access failed", C.dim)
      try { await unlink(dest) } catch {}
      return
    }

    const cmd = `read_image ${dest}`
    state.input.splice(state.cursor, 0, ...[...cmd])
    state.cursor += cmd.length
    pushLine(`[image pasted → ${dest}]`, C.tool)
    render()
  }

  // ---------------------------------------------------------- 斜杠Commands

  const SLASH_COMMANDS = [
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
        cleanup()
        setTimeout(() => process.exit(0), 100) // 延迟一拍：fetch 后立刻 exit 在 Windows/Node 24 会触发 libuv 断言
        return
      case "/session": {
        const slots = listSlots(agent.cwd)
        if (slots.length === 0) {
          pushLine("No archived sessions (use /new and old sessions auto-archive to slots)", C.dim)
        } else {
          const entries = [
            { type: "header", text: "Archived sessions (↑↓ select, Enter switch, Esc cancel)" },
            ...slots.map((s) => ({ type: "item", text: `Slot ${s.slot} — ${s.date}`, slot: s.slot })),
          ]
          openPicker({
            title: "Switch Session",
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
        const { syncDir, codeSync, docSync } = await import("./memory.mjs")
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
            }
          }),
          docSync(agent.memory, agent.cwd, {
            onProgress: (p) => {
              if (p.phase === "index" && p.current % 5 === 0) {
                pushLine(`    doc: ${p.current}/${p.total}`, C.dim)
              }
            }
          }),
        ])
        pushLine(`  code: ${cr.total} files, +${cr.updated} ~${cr.skipped} -${cr.removed}`, C.dim)
        pushLine(`  doc: ${dr.total} files, +${dr.updated} ~${dr.skipped} -${dr.removed}`, C.dim)
        pushLine(`[reindex] Done, ${total} entries total. Vectors will be lazily generated on next search.`, C.tool)
        return
      }
      case "/extract":
        await runDistill()
        return
      case "/init": {
        const { existsSync } = await import("node:fs")
        const { writeFile, readFile } = await import("node:fs/promises")
        const { join, basename } = await import("node:path")
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
          else if (existsSync(join(agent.cwd, "build.gradle")) || existsSync(join(agent.cwd, "build.gradle.kts"))) {
            lang = "Java/Kotlin (Gradle)"; cmds = "- `gradle test`"
          }
        }

        const lines = [`# ${name}`, ""]
        if (lang) {
          lines.push(`## Tech Stack`, "", lang, "")
          if (cmds) lines.push(`## Commands`, "", cmds, "")
        }

        const template = lines.join("\n")
        await writeFile(agPath, template, "utf8")
        pushLabel(`❯ Init`, ansi.bold + C.tool)
        pushLine(`Generated AGENTS.md → ${agPath}${lang ? ` (${lang})` : ""}`, C.tool)
        if (lang) pushLine("Tell me more about the project and I will fill in conventions and structure", C.dim)
        return
      }
      case "/restore": {
        const { listCheckpoints, rewind, isGitRepo } = await import("./checkpoint.mjs")
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
            text: `${cp.id}  ${new Date(cp.time).toLocaleString()}  (+${cp.untracked}  untracked files)`,
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
              pushLine(`Restored to ${e.id}: patch ${summary.patchApplied ? "applied" : "none"}，deleted ${summary.deleted}  new files, restored ${summary.restored} 个`, C.tool)
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
          onSelect: (e) => {
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
            askQuestion("Enter goal description (; separates criteria)").then((text) => {
              if (!text) return
              const semi = text.indexOf("；") >= 0 ? "；" : text.indexOf(";") >= 0 ? ";" : null
              const objective = semi ? text.slice(0, semi).trim() : text.trim()
              const criteria = semi ? text.slice(semi + 1).trim() : ""
              agent.goal = { objective, criteria, setAt: Date.now(), status: "active", turnsUsed: 0, _blockTally: null }
              pushLabel(`❯ Goal`, ansi.bold + C.warn)
              pushLine(`Goal set: ${objective}`, C.tool)
              if (criteria) pushLine(`  Criteria: ${criteria}`, C.dim)
              else pushLine(`  ⚠ No criteria — agent will be asked to provide verifiable criteria when using goal set`, C.warn)
            })
          },
        })
        return
      }
      case "/skills": {
        const { loadSkills } = await import("./skills.mjs")
        const skills = await loadSkills(agent.cwd)
        pushLabel(`❯ Skills`, ansi.bold + C.tool)
        if (skills.length === 0) {
          pushLine(" (none项目技能——在 .thincoder/skills/ 下创建 .md 文件即可添加）", C.dim)
        }
        for (const s of skills) {
          pushLine(`  ${s.name}: ${s.description.slice(0, 100)}`, C.dim)
        }
        pushLine("激活: 告诉 agent \"load the <name> skill\"", C.dim)
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
                pushLine(" (none MCP server）", C.dim)
              }
              for (const srv of servers) {
                const connected = agent.tools.some((t) => t._mcpName === srv.name)
                const mark = connected ? "●" : "○"
                const color = connected ? C.tool : C.dim
                const toolCount = agent.tools.filter((t) => t._mcpName === srv.name).length
                const desc = srv.wsUrl ? srv.wsUrl : srv.url ? srv.url : `${srv.command} ${(srv.args ?? []).join(" ")}`
                pushLine(`  ${mark} ${srv.name}: ${desc}  (${toolCount} tools)`, color)
              }
              return
            }
            if (e.action === "remove") {
              const removeEntries = [
                { type: "header", text: "Select server to remove" },
                ...servers.map((s) => ({ type: "item", text: s.name, name: s.name })),
              ]
              openPicker({
                title: "Remove MCP",
                entries: removeEntries,
                onSelect: async (se) => {
                  const { removeMcpTools } = await import("./mcp.mjs")
                  removeMcpTools(agent, se.name)
                  await persistRaw((raw) => { raw.mcp ??= { servers: [] }; raw.mcp.servers = raw.mcp.servers.filter((s) => s.name !== se.name) })
                  if (agent.config?.mcp?.servers) agent.config.mcp.servers = agent.config.mcp.servers.filter((s) => s.name !== se.name)
                  pushLabel(`❯ MCP`, ansi.bold + C.tool)
                  pushLine(`${se.name} disconnected and removed from config.`, C.tool)
                },
              })
              return
            }
            if (e.action === "connect") {
              const connEntries = [
                { type: "header", text: "Select server to reconnect" },
                ...servers.map((s) => ({ type: "item", text: s.name, name: s.name })),
              ]
              openPicker({
                title: "Reconnect MCP",
                entries: connEntries,
                onSelect: async (se) => {
                  const srv = servers.find((s) => s.name === se.name)
                  if (!srv) return
                  const { removeMcpTools, connectMcpServer } = await import("./mcp.mjs")
                  removeMcpTools(agent, se.name)
                  try {
                    pushLine(`[mcp] Reconnecting ${se.name}...`, C.dim)
                    const tools = await connectMcpServer(srv)
                    agent.tools.push(...tools)
                    pushLabel(`❯ MCP`, ansi.bold + C.tool)
                    pushLine(`${se.name} reconnected, ${tools.length}  tools available.`, C.tool)
                  } catch (error) {
                    pushLine(`[mcp] ${se.name}: ${error.message}`, C.error)
                  }
                },
              })
              return
            }
            if (e.action === "add") {
              askQuestion("输入: <名称> <URL|Commands> [参数...]\nURL 自动识别: https://… → HTTP, ws://… → WebSocket, 其他 → stdio Commands").then(async (text) => {
                if (!text) return
                const parts = text.split(/\s+/)
                if (parts.length < 2) { pushLine("用法: <名称> <URL|Commands> [参数...]", C.error); return }
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
                await addAndConnect(srv)
              })
            }
          },
        })
        return
      }

      // ---- header 解析 (/mcp add 共享）----
      function parseHeaders(pairs) {
        const headers = {}
        for (const pair of pairs) {
          const eq = pair.indexOf("=")
          if (eq > 0) headers[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/^["']|["']$/g, "")
        }
        return headers
      }

      // ---- /mcp 共享 helper: 保存Config + Connecting ----
      async function addAndConnect(srv) {
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
          const { connectMcpServer } = await import("./mcp.mjs")
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
        const { specForModel } = await import("./config.mjs")
        const spec = specForModel(cur.model)
        const isEffortOnly = spec.thinkApi === "effort"
        // effort 档位按规格表动态读，不硬编码——各模型支持的枚举不同
        const effortLevels = spec.reasoningEffortEnum ?? ["high", "max"]

        const entries = [
          { type: "header", text: "Thinking mode" },
          { type: "item", text: `On${thinkingEnabled ? "  ← current" : ""}`, action: "on" },
          { type: "item", text: `Off${!thinkingEnabled ? "  ← current" : ""}`, action: "off" },
          { type: "header", text: "Reasoning effort" },
          ...effortLevels.map((l) => ({
            type: "item",
            text: `${l}${cur.reasoningEffort === l ? "  ← current" : ""}`,
            action: "effort",
            level: l,
          })),
        ]
        openPicker({
          title: "Thinking mode",
          entries,
          defaultIndex: thinkingEnabled ? 0 : 1,
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
              pushLine(`Thinking mode已${enable ? "On" : "Off"}`, C.tool)
              if (enable) pushLine(`Reasoning effort: ${cur.reasoningEffort}`, C.dim)
            }
          },
        })
        return
      }
      case "/model": {
        openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
        return
      }
      case "/provider": {
        const entries = [
          { type: "header", text: `${agent.providers.length} providers` },
          { type: "item", text: "View list", action: "list" },
          { type: "item", text: "Add provider", action: "add" },
        ]
        if (agent.providers.length > 0) {
          entries.push(
            { type: "item", text: "Remove provider", action: "remove" },
          )
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
                { type: "header", text: "选择要移除的 provider (current使用的不可移除）" },
                ...candidates.map((p) => ({ type: "item", text: `${p.name} (${p.model})`, name: p.name })),
              ]
              openPicker({
                title: "Remove Provider",
                entries: removeEntries,
                onSelect: async (se) => {
                  const at = agent.providers.findIndex((p) => p.name === se.name)
                  agent.providers.splice(at, 1)
                  await persistRaw((raw) => { raw.providers = agent.providers })
                  pushLabel(`❯ Provider`, ansi.bold + C.tool)
                  pushLine(`Removed ${se.name}`, C.tool)
                },
              })
              return
            }
            if (e.action === "add") {
              // 菜单选预设 → 输 API key → 完成
              const presetEntries = [
                { type: "header", text: "选择预设 provider" },
                ...Object.entries(PRESETS).map(([name, p]) => ({
                  type: "item",
                  text: `${name.padEnd(10)} ${p.desc ?? ""} (${p.model})`,
                  name,
                })),
                { type: "header", text: "其他" },
                { type: "item", text: "自定义 (手动配置)", name: "__custom__" },
              ]
              openPicker({
                title: "Add Provider",
                entries: presetEntries,
                onSelect: async (se) => {
                  if (se.name === "__custom__") {
                    // 自定义：逐项输入 name → baseURL → model → key
                    askQuestion("输入 provider 名称:").then(async (name) => {
                      if (!name) return
                      if (agent.providers.some((p) => p.name === name)) {
                        pushLine(`"${name}" already exists；先 /provider → 移除`, C.warn)
                        return
                      }
                      askQuestion("输入 baseURL (如 https://api.example.com/v1):").then(async (baseURL) => {
                        if (!baseURL) { pushLine("已取消", C.dim); return }
                        baseURL = baseURL.replace(/\/+$/, "")
                        if (!/^https?:\/\//.test(baseURL)) { pushLine(`baseURL must start with http(s)://`, C.error); return }
                        askQuestion("输入 model 名称:").then(async (model) => {
                          if (!model) { pushLine("已取消", C.dim); return }
                          agent.providers.push({ name, baseURL, model })
                          await persistRaw((raw) => { raw.providers = agent.providers })
                          pushLabel(`❯ Provider`, ansi.bold + C.tool)
                          pushLine(`Added ${name} (${baseURL} / ${model}）`, C.tool)
                          askQuestion(`Enter API key for ${name} (留空跳过):`).then(async (key) => {
                            if (key) { await setProviderKey(name, key); pushLine(`Key saved for ${name}`, C.tool) }
                            else { pushLine(`跳过 key。之后 /provider → Set API Key 配置`, C.dim) }
                          })
                        })
                      })
                    })
                    return
                  }
                  // 预设：name/baseURL/model 全自动填
                  const preset = PRESETS[se.name]
                  if (agent.providers.some((p) => p.name === se.name)) {
                    pushLine(`"${se.name}" already exists；先 /provider → 移除`, C.warn)
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
                  pushLine(`Added ${se.name} (${preset.baseURL} / ${preset.model}）`, C.tool)
                  // 直接接 key 输入
                  askQuestion(`Enter API key for ${se.name} (留空跳过，之后 /provider → Set Key):`).then(async (key) => {
                    if (key) {
                      await setProviderKey(se.name, key)
                      pushLine(`Key saved for ${se.name}`, C.tool)
                    } else {
                      pushLine(`跳过 key。之后 /provider → Set API Key 配置`, C.dim)
                    }
                  })
                },
              })
              return
            }
            if (e.action === "key") {
              // Key: pick which provider, then prompt for key
              const keyEntries = [
                { type: "header", text: "Select provider to configure key" },
                ...agent.providers.map((p) => ({
                  type: "item",
                  text: `${p.name}${p.name === agent.activeProvider ? " ← current" : ""}${p.apiKey ? " ●has key" : " ○nonekey"}`,
                  name: p.name,
                })),
              ]
              openPicker({
                title: "Configure API Key",
                entries: keyEntries,
                onSelect: (se) => {
                  askQuestion(`Enter API key for ${se.name}:`).then(async (key) => {
                    if (!key) {
                      pushLine(`跳过 key 输入`, C.dim)
                      return
                    }
                    await setProviderKey(se.name, key)
                  })
                },
              })
            }
          },
        })
        return
      }
      case "/config": {
        const entries = [
          { type: "header", text: "Config" },
          { type: "item", text: "View current config", action: "view" },
          { type: "item", text: "Set embedding key (vector search)", action: "embedkey" },
          { type: "item", text: "Advanced (set path value)", action: "set" },
        ]
        openPicker({
          title: "Config",
          entries,
          onSelect: async (e) => {
            if (e.action === "view") {
              const { configPath: cp } = await import("./config.mjs")
              pushLabel(`❯ Config`, ansi.bold + C.tool)
              pushLine(`Active: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
              pushLine(`Key:    ${maskKey(agent.provider.apiKey)}`, C.dim)
              const ac = agent.config?.agent ?? {}
              const tn = `${ac.compactThreshold ?? 100000}${ac.compactThresholdAuto ? " (auto)" : ""}`
              pushLine(`agent:  maxTurns=${ac.maxTurns ?? 100} | compactThreshold=${tn}`, C.dim)
              pushLine(`embedding: ${agent.memory?.embedder ? `enabled (${agent.config?.embedding?.model ?? ""})` : "disabled (FTS only)"}`, C.dim)
              pushLine(`Config文件: ${cp}`, C.dim)
              return
            }
            if (e.action === "embedkey") {
              askQuestion("Enter embedding API key (default: SiliconFlow bge-m3):").then(async (key) => {
                if (!key) return
                agent.config.embedding ??= {}
                agent.config.embedding.apiKey = key
                await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: key } })
                if (agent.memory) {
                  const { createEmbedder } = await import("./embedding.mjs")
                  agent.memory.embedder = createEmbedder(agent.config.embedding)
                }
                pushLabel(`❯ Config`, ansi.bold + C.tool)
                pushLine(`Embedding key saved, vector search enabled`, C.tool)
              })
              return
            }
            if (e.action === "set") {
              askQuestion("Enter: <path> <value> (e.g. agent.maxTurns 80, supports a.b nesting):").then(async (text) => {
                if (!text) return
                const parts = text.split(/\s+/)
                const [path, value] = [parts[0], parts.slice(1).join(" ")]
                if (!path || !value) { pushLine("Usage: <path> <value>  e.g. agent.maxTurns 80", C.error); return }
                try {
                  const { configPath, loadConfig, saveConfig } = await import("./config.mjs")
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
              })
            }
          },
        })
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
        const entries = []
        for (const g of order) {
          const cmds = byGroup.get(g)
          if (!cmds?.length) continue
          entries.push({ type: "header", text: g })
          for (const c of cmds) {
            const alias = aliasList[c.name]
            entries.push({ type: "item", text: `${c.name}${alias ? ` (${alias})` : ""}  ${c.desc}`, cmd: c.name })
          }
        }
        openPicker({
          title: "Commands (↑↓ select, Enter run, Esc close)",
          entries,
          onSelect: (e) => {
            // 选中即执行该命令
            handleSlash(e.cmd)
          },
        })
        return
      }
      default:
        pushLine(`Unknown command: ${cmd} (/help 查看可用Commands）`, C.error)
        return
    }
  }

  function maskKey(key) {
    if (!key) return "(none)"
    if (key.length <= 8) return "***"
    return `${key.slice(0, 5)}…${key.slice(-4)}`
  }

  /** Tab 补全候选：Commands名 / 子Commands / provider 名 / 预设名 / think 参数 */
  function completions(input) {
    if (!input.startsWith("/")) return []
    const parts = input.split(/\s+/)
    // 还在敲第一个 token：补Commands名
    if (parts.length === 1) {
      return SLASH_COMMANDS.filter((c) => c.name.startsWith(parts[0])).map((c) => c.name)
    }
    const cmd = parts[0]
    const last = parts.at(-1) // 结尾是空格时Enter API key for ""，即列出全部候选
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

  /** 读Config文件 → 修改 → 写回；文件not found时从空对象开始 */
  async function persistRaw(mutate) {
    const { saveConfig, configPath } = await import("./config.mjs")
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    saveConfig(raw)
  }

  /** 把current激活 provider 的某个字段同步到 providers 列表并持久化 */
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

  // ---------------------------------------------------------- 模型选择器 (/model）

  const pickerItems = () => state.picker?.entries.filter((e) => e.type === "item") ?? []

  /** 打开通用列表选择器。entries 含 { type: "header"|"item", text, note?, ...extra }，
   *  onSelect 拿到选中条目 (含 extra 字段透传），onCancel 在 Esc 时调。 */
  function openPicker({ title, entries, onSelect, onCancel, defaultIndex = 0 }) {
    state.picker = { title, entries, lines: [], index: defaultIndex, scroll: 0, selectedLine: 0, onSelect, onCancel }
    renderPickerLines()
  }

  function closePicker() {
    state.picker?.onCancel?.()
    state.picker = null
    render()
  }

  /** 按 entries 重建显示行并刷新 */
  function renderPickerLines() {
    const p = state.picker
    if (!p) return
    const lines = []
    let row = 0
    let selectedLine = 0
    for (const e of p.entries) {
      if (e.type === "header") {
        lines.push({ text: ` ${e.text}${e.note ? `  ${e.note}` : ""}`, color: ansi.bold + C.tool })
      } else {
        const selected = row === p.index
        if (selected) selectedLine = lines.length
        const marker = e.marker ? `  ${e.marker}` : ""
        lines.push({
          text: `${selected ? " ▸ " : "   "}${e.text}${marker}`,
          color: selected ? ansi.bold + C.text : C.dim,
        })
        row++
      }
    }
    p.lines = lines
    p.selectedLine = selectedLine
    render()
  }

  // ========== 模型选择器 (基于通用 picker，异步拉取远端模型列表） ==========

  async function openModelPicker() {
    const entries = []
    for (const p of agent.providers) {
      entries.push({ type: "header", text: p.name, note: `${p.baseURL}${p.apiKey ? "" : " (no key)"}  loading...` })
      entries.push({ type: "item", text: p.model, provider: p.name, model: p.model })
    }
    const onSelect = (e) => selectModel(e).catch((err) => pushLine(`[error] ${err.message}`, C.error))
    openPicker({ title: "Select Model", entries, onSelect })
    // 默认选中current在用的模型
    const current = pickerItems().findIndex(
      (e) => e.provider === agent.activeProvider && e.model === agent.provider.model,
    )
    if (current >= 0) state.picker.index = current
    renderPickerLines()

    const { listModels } = await import("./provider.mjs")
    await Promise.all(
      agent.providers.map(async (p) => {
        const header = entries.find((e) => e.type === "header" && e.provider === undefined && e.text === p.name)
        const noteBase = `${p.baseURL}${p.apiKey ? "" : " (no key)"}`
        try {
          const envKey = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY" }[p.name]
          let apiKey = p.apiKey
          if (!apiKey && envKey && process.env[envKey]) apiKey = process.env[envKey]
          if (!apiKey) apiKey = process.env.THINCODER_API_KEY
          const models = await listModels(
            { baseURL: p.baseURL, apiKey: apiKey ?? "" },
            { signal: AbortSignal.timeout(10000) },
          )
          const at = entries.findIndex((e) => e.type === "item" && e.provider === p.name && e.model === p.model)
          entries.splice(
            at + 1,
            0,
            ...models.filter((m) => m !== p.model).map((m) => ({ type: "item", text: m, provider: p.name, model: m })),
          )
          if (header) header.note = noteBase
        } catch (error) {
          if (header) header.note = `${noteBase}   (fetch failed: ${sliceByWidth(error.message, 60)}）`
        }
        if (state.picker?.entries === entries) renderPickerLines()
      }),
    )
  }

  /** 给指定 provider 写 key (内存 + Config文件）；若它是current激活的，同步运行时 */
  async function setProviderKey(name, key) {
    const target = agent.providers.find((p) => p.name === name)
    if (!target) {
      pushLine(`Provider "${name}"`, C.error)
      return
    }
    target.apiKey = key
    if (name === agent.activeProvider) agent.provider.apiKey = key
    await persistRaw((raw) => { raw.providers = agent.providers })
    pushLabel(`❯ Provider`, ansi.bold + C.tool)
    pushLine(`API key saved to ${name}`, C.tool)
  }

  // ---------------------------------------------------------- 初始Config向导 (首次启动）

  /** 菜单步的候选项：已有 provider (no key 的标注）+ 未添加的预设 + 自定义 */
  function wizardProviderItems() {
    const items = []
    for (const p of agent.providers) {
      items.push({ kind: "existing", name: p.name, baseURL: p.baseURL, model: p.model, label: `${p.name} (added${p.apiKey ? "" : "，no key"}）` })
    }
    for (const [name, p] of Object.entries(PRESETS)) {
      if (!agent.providers.some((x) => x.name === name)) {
        items.push({ kind: "preset", name, baseURL: p.baseURL, model: p.model, label: `${name} (${p.desc}）` })
      }
    }
    items.push({ kind: "custom", name: null, label: "Custom endpoint…" })
    return items
  }

  /** 文本步骤定义：提示语 + 校验 (通过返回 true，否则返回错误文案） */
  const WIZARD_STEPS = {
    name: {
      prompt: "给这个 provider 起个名字 (字母/数字/-/_，如 my-openai）",
      validate: (v) =>
        (/^[\w-]+$/.test(v) && !agent.providers.some((p) => p.name === v)) || "Name must be alphanumeric/-/_ and unique",
    },
    baseURL: {
      prompt: "输入 baseURL (如 https://api.openai.com/v1）",
      validate: (v) => /^https?:\/\/.+/.test(v) || "baseURL must start with http(s)://",
    },
    model: {
      prompt: "输入模型名 (如 gpt-4o）",
      validate: (v) => v.length > 0 || "Model name required",
    },
    key: {
      prompt: "输入 API key",
      validate: (v) => v.length > 0 || "key 不能为空",
    },
    embedkey: {
      prompt: "可选：embedding API key (SiliconFlow，记忆向量检索用；直接回车跳过）",
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
      lines.push({ text: " Choose a model provider:", color: C.text })
      wizardProviderItems().forEach((it, i) => {
        if (i === w.index) w.selectedLine = lines.length
        lines.push({
          text: `${i === w.index ? " ▸ " : "   "}${it.label}`,
          color: i === w.index ? ansi.bold + C.text : C.dim,
        })
      })
    } else {
      const f = w.fields
      if (f.name) lines.push({ text: ` Provider:  ${f.name}`, color: C.dim })
      if (f.baseURL) lines.push({ text: ` baseURL: ${f.baseURL}`, color: C.dim })
      if (f.model) lines.push({ text: ` 模型:    ${f.model}`, color: C.dim })
      lines.push({ text: ` ❯ ${WIZARD_STEPS[w.step].prompt}`, color: ansi.bold + C.text })
      lines.push({ text: " (type in input box below)", color: C.dim })
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
    pushLine("已跳过初始Config。之后随时可用 /provider add 添加Provider、/provider key 配 key。", C.dim)
    render()
  }

  /** 向导完成：写入 provider (有则更新）、设为激活、持久化，然后接模型选择器 */
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
    pushLine(`Setup complete: ${f.name} / ${f.model} (saved to config)`, C.tool)
    // embedding key：配了就启用向量检索，没配提示事后通道
    if (f.embedkey) {
      agent.config.embedding ??= {}
      agent.config.embedding.apiKey = f.embedkey
      await persistRaw((raw) => { raw.embedding = { ...(raw.embedding ?? {}), apiKey: f.embedkey } })
      if (agent.memory && !agent.memory.embedder) {
        const { createEmbedder } = await import("./embedding.mjs")
        agent.memory.embedder = createEmbedder(agent.config.embedding)
      }
      pushLine(`Vector search enabled (${agent.config.embedding.model ?? "BAAI/bge-m3"}）`, C.tool)
    } else {
      pushLine(`向量检索未启用 (记忆退化为纯文本检索）；之后可 /config embedkey <key> On`, C.dim)
    }
    pushLine(`Select model (Esc to keep ${f.model}）`, C.dim)
    openModelPicker().catch((e) => pushLine(`[error] ${e.message}`, C.error))
  }

  /** 选中：切换 provider + 模型，持久化，阈值随模型走 */
  async function selectModel(item) {
    closePicker()
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
      thresholdNote = `, compact threshold adjusted to ${value}`
    }
    await persistRaw((raw) => {
      raw.providers = agent.providers
      raw.activeProvider = item.provider
    })
    agent.config.activeProvider = item.provider
    pushLabel(`❯ Model`, ansi.bold + C.tool)
    pushLine(`Switched to ${item.provider} / ${item.model}${thresholdNote} (persisted)`, C.tool)
    if (!agent.provider.apiKey) {
      pushLine(`Provider has no key`, C.warn)
      askQuestion(`Enter API key for ${item.provider} (留空跳过):`).then(async (key) => {
        if (key) {
          await setProviderKey(item.provider, key)
        } else {
          pushLine(`跳过。之后 /provider → Set API Key 配置`, C.dim)
        }
      })
    }
  }

  /** /distill：从current会话提取候选，逐条 y/n 确认后入库 */
  async function runDistill() {
    if (agent.history.length === 0) {
      pushLine("[distill] current会话为空，没有可提取的内容", C.dim)
      return
    }
    state.processing = true
    state.status = "Distilling..."
    render()
    try {
      const { extractCandidates, historyToTranscript, saveCandidate } = await import("./distill.mjs")
      pushLine("[distill] Analyzing session...", C.tool)
      const candidates = await extractCandidates(agent.provider, historyToTranscript(agent.history))
      if (candidates.length === 0) {
        pushLine("[distill] No knowledge worth saving from this session", C.dim)
        return
      }
      let saved = 0
      for (const c of candidates) {
        pushLine(`── Candidate [${c.type}] ${c.title} (scope: ${c.scope ?? "personal"})`, C.warn)
        for (const line of c.content.split("\n").slice(0, 6)) pushLine(`   ${line}`, C.dim)
        if (c.type === "rule") pushLine("   (rule  type — consider writing manually; press y to extract)", C.warn)
        const accept = await askPermission("distill-save", { title: c.title })
        if (!accept) {
          pushLine("   skipped", C.dim)
          continue
        }
        const where = await saveCandidate(agent.memory, c, distillOpts)
        pushLine(`   saved -> ${where}`, C.tool)
        saved++
      }
      pushLine(`[distill] Done: saved ${saved}/${candidates.length} 条`, C.tool)
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
    // 权限确认态：y 批准 / n 拒绝 / a 批准并On AUTO (后续不再询问）
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
          pushLine(`  [auto] AUTO 已On：后续工具调用不再询问 (/auto Off）`, C.warn)
        }
        const approved = answer === "y" || (answer === "a" && !isContinue)
        // 决定落痕：对话区留下批准/拒绝记录 (continue 询问有自己的输出，不重复记）
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
        pushLine("[Aborting…]", C.warn)
        render()
        return
      }
      cleanup()
      setTimeout(() => process.exit(0), 100)
    }

    // 通用列表选择器：↑↓ 移动，Enter 确认，Esc 取消
    if (state.picker) {
      const items = pickerItems()
      if (key.name === "escape") {
        closePicker()
      } else if (key.name === "up" && items.length) {
        state.picker.index = (state.picker.index - 1 + items.length) % items.length
        renderPickerLines()
      } else if (key.name === "down" && items.length) {
        state.picker.index = (state.picker.index + 1) % items.length
        renderPickerLines()
      } else if (key.name === "return" && items.length) {
        const selected = items[state.picker.index]
        const handler = state.picker.onSelect
        state.picker = null // 先关 picker，避免 onSelect 内部 render 时 picker 还在
        // onSelect 是 async（如删 provider 要写文件），用 catch 兜住错误不被吞
        Promise.resolve(handler?.(selected)).catch((err) => {
          pushLine(`[error] ${err.message}`, C.error)
        }).finally(() => render())
      }
      return
    }

    // 初始Config向导：菜单步 ↑↓/Enter/Esc；文本步 Enter 提交、Esc 取消，编辑键落到正常输入
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

    if (state.processing) {
      // 处理中允许输入（排队），但屏蔽方向键历史和 Tab 补全
      if (key.name === "tab" || key.name === "up" || key.name === "down") return
      // Ctrl+D：删除队列中最后一条
      if (key.ctrl && key.name === "d") {
        if (state.queue.length > 0) {
          state.queue.pop()
          render()
        }
        return
      }
      // 其余可打印字符正常进入输入框
    }

    // Tab：斜杠Commands补全 (循环候选）；其余输入忽略 (\t 会顶破输入框，永不直接插入）
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
      submit().catch((e) => pushLine(`[error] ${e.message}`, C.error))
      return
    }

    // Ctrl+V (Unix) / Alt+V (Windows)：粘贴剪贴板图片 → 存临时文件 → 输入框插入 read_image
    const isPasteImage = (key.name === "v" && (key.ctrl || key.meta)) || (key.name === "v" && key.alt)
    if (isPasteImage) {
      pasteClipboardImage(agent).catch((e) => pushLine(`[error] ${e.message}`, C.error))
      return
    }

    // 可打印字符 / 粘贴 (str 可能一次多个字符）；Tab 一律转成两个空格 (\t 显示宽度不定，会顶破输入框）
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
    pushLabel(`Welcome to ThinCoder!`, ansi.bold + C.tool)
    pushLine("检测到还没Config API key，进入初始Config (Esc 可随时跳过）", C.text)
    startWizard()
  } else {
    pushLine(`Welcome to ThinCoder. Provider: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
  }
  pushLine(`Tools: ${agent.tools.map((t) => t.name).join(", ")}`, C.dim)
  // 恢复上次会话：重建对话区显示 (tool 结果行省略，保持清爽）
  if (opts.restored?.display?.length) {
    // 用户视角的恢复：display 是退出前对话区的原样快照，所见即所得
    state.lines = [...opts.restored.display.map((l) => ({ text: l.text, color: l.color })), ...state.lines]
    pushLabel(`── Restored previous session; /new for a fresh session ──`, C.warn)
  } else if (opts.restored?.history?.length) {
    // 重建对话区：user/assistant 消息逐条展示，tool 结果行只保留首行摘要
    for (let i = 0; i < opts.restored.history.length; i++) {
      const m = opts.restored.history[i]
      if (m.role === "user") {
        if (typeof m.content === "string" && m.content.startsWith("[System reminder:")) continue
        pushLabel(`❯ You:`, ansi.bold + C.user)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
      } else if (m.role === "assistant") {
        pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
        if (typeof m.content === "string" && m.content) pushLine(m.content, C.text)
        for (const tc of m.tool_calls ?? []) {
          // 找到下一条对应的 tool 结果，显示首行摘要
          const toolResult = opts.restored.history[i + 1]
          const hasResult = toolResult?.role === "tool" && toolResult?.tool_call_id === tc.id
          const summary = hasResult ? " → " + sliceByWidth(String(toolResult.content).split("\n")[0], 80) : ""
          pushLine(`  [tool] ${tc.function?.name ?? "?"}${summary}`, C.tool)
        }
      }
      // tool 消息本身不单独渲染——已在 assistant 的 tool_calls 后以摘要形式展示
    }
    pushLabel(`── Restored previous session (${opts.restored.history.length}  messages); /new for a fresh session ──`, C.warn)
  }
  // 有归档槽位时给个提示
  if (listSlots(agent.cwd).length > 0) {
    pushLine("Tip: archived sessions available — /session to view/switch", C.dim)
  }
  render()

  // 后台索引 (进界面后再跑，不阻塞启动）；进度走底部状态栏，不往对话区塞行
  // 优先用 git diff 增量（快），git 不可用或首次运行时退到全量扫描
  ;(async () => {
    const { codeSync, docSync, gitSync } = await import("./memory.mjs")
    const cwd = agent.cwd
    let codeFiles = 0, docFiles = 0

    state.status = "Indexing..."
    render()

    const gitRes = await gitSync(agent.memory, cwd, {
      onProgress: (p) => {
        if (p.phase === "index" && p.current % 5 === 0) {
          state.status = `Indexing... ${p.current}/${p.total}`
          render()
        }
      }
    })

    if (gitRes !== null) {
      // git 增量成功，直接统计
      codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
      docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
    } else {
      // 退到全量扫描（codeSync 和 docSync 并行——读写不同表，SQLite WAL 天然支持）
      const [codeRes, docRes] = await Promise.allSettled([
        codeSync(agent.memory, cwd, {
          onProgress: (p) => {
            if (p.phase === "index" && p.current % 30 === 0) {
              state.status = `Indexing code... ${p.current}/${p.total}`
              render()
            }
          }
        }),
        docSync(agent.memory, cwd, {
          onProgress: (p) => {
            if (p.phase === "index" && p.current % 10 === 0) {
              state.status = `Indexing docs... ${p.current}/${p.total}`
              render()
            }
          }
        }),
      ])
      if (codeRes.status === "fulfilled") {
        codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
      }
      if (docRes.status === "fulfilled") {
        docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
      }
    }

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
