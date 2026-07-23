/**
 * tui.mjs — 裸 ANSI 终端 UI
 * 零依赖：raw mode 键盘输入、ANSI 转义渲染、自研宽字符换行。
 * 布局：header / 对话区（可滚动）/ 输入框 / 状态栏。
 */

import { emitKeypressEvents } from "node:readline"
import { PassThrough } from "node:stream"
import { basename } from "node:path"
import { runAgent } from "./agent.mjs"

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
  user: ansi.fg(4), // blue
  assistant: ansi.fg(2), // green
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
    permission: null, // { name, args, resolve }
    tasks: [], // task 工具的任务列表（状态栏显示进度）
    status: "Ready",
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

  const cleanup = () => {
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
      pushLabel(`❯ ThinCoder`, ansi.bold + C.assistant)
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
    const inputBoxH = inputLines.length + 2

    const headerH = 1
    const statusH = 1
    const convH = Math.max(1, rows - headerH - inputBoxH - statusH)

    // 对话区内容行（含流式缓冲）
    const convLines = []
    for (const l of state.lines) {
      for (const wrapped of wrapText(l.text, cols - 1)) {
        convLines.push({ text: wrapped, color: l.color })
      }
    }
    if (state.streaming) {
      for (const wrapped of wrapText(state.streaming, cols - 1)) {
        convLines.push({ text: wrapped, color: C.assistant })
      }
    }

    const maxScroll = Math.max(0, convLines.length - convH)
    state.scroll = Math.min(state.scroll, maxScroll)
    const end = convLines.length - state.scroll
    const visible = convLines.slice(Math.max(0, end - convH), end)

    const out = [ansi.home]

    // header
    out.push(
      `${ansi.bold}${C.tool} ThinCoder ${ansi.reset}${ansi.dim}│ ${model} │ ${basename(agent.cwd)}${ansi.reset}${ansi.clearLine}`,
    )

    // 对话区（不足部分补空行，把输入框钉在底部）
    const pad = convH - visible.length
    for (let i = 0; i < pad; i++) out.push(ansi.clearLine)
    for (const l of visible) {
      out.push(`${l.color}${l.text}${ansi.reset}${ansi.clearLine}`)
    }

    // 输入框（全边框，宽 W）
    const borderColor = state.permission ? C.warn : C.tool
    const title = state.permission
      ? ` Allow ${state.permission.name}? (y/n) `
      : state.processing
        ? " Processing... "
        : " Input "
    const topBorder = `╭─${title}${"─".repeat(Math.max(0, W - 3 - stringWidth(title)))}╮`
    out.push(`${borderColor}${topBorder}${ansi.reset}${ansi.clearLine}`)
    for (const l of inputLines) {
      const content = sliceByWidth(l, W - 4)
      const fill = " ".repeat(Math.max(0, W - 4 - stringWidth(content)))
      out.push(`${borderColor}│${ansi.reset} ${content}${fill} ${borderColor}│${ansi.reset}${ansi.clearLine}`)
    }
    out.push(`${borderColor}╰${"─".repeat(Math.max(0, W - 2))}╯${ansi.reset}${ansi.clearLine}`)

    // 状态栏（输入 / 开头时变为命令提示）
    const scrollHint = state.scroll > 0 ? ` │ scrolled ${state.scroll}` : ""
    const rawInput = state.input.join("")
    let statusLine
    if (rawInput.startsWith("/") && !state.processing && !state.permission) {
      const prefix = rawInput.split(/\s/)[0]
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
      statusLine = matches.length > 0
        ? ` ${matches.map((c) => `${c.name} ${c.desc}`).join("  │  ")}`
        : ` 未知命令（/help 查看可用命令）`
    } else {
      const taskHint = state.tasks.length > 0
        ? ` │ ▶${state.tasks.filter((t) => t.status === "done").length}/${state.tasks.length}`
        : ""
      statusLine = ` ${state.status}${taskHint}${scrollHint} │ Enter: send │ /: commands │ wheel/PgUp/PgDn: scroll │ Ctrl+C: exit`
    }
    out.push(`${ansi.dim}${statusLine}${ansi.reset}${ansi.clearLine}`)

    const frame = out.join("\r\n")
    if (frame !== lastFrame) {
      lastFrame = frame
      process.stdout.write(frame)
    }

    // 光标：输入态定位到输入框内（IME 候选框跟随真实光标）；处理中/权限确认时隐藏
    if (state.processing || state.permission) {
      process.stdout.write(ansi.hideCursor)
    } else {
      const cursorRow = 1 + convH + 2 + (layout.cursorLine - inputOffset) // header + 对话区 + 上边框 + 行偏移
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

    pushLabel(`❯ You`, ansi.bold + C.user)
    pushLine(text, C.user)

    assistantLabeled = false
    state.processing = true
    state.status = "Processing..."
    state.streaming = ""
    render()

    try {
      await runAgent(agent, text, {
        onToken: (t) => {
          ensureAssistantLabel()
          state.streaming += t
          scheduleRender() // token 洪流限流，防闪屏
        },
        onReasoning: () => {}, // 思考流 v1 不展示
        onToolCall: (name, args) => {
          flushStream()
          ensureAssistantLabel()
          pushLine(`  [tool] ${name} ${summarize(args)}`, C.tool)
        },
        onToolResult: (name, result) => {
          const first = result.split("\n")[0]
          pushLine(`  [done] ${name} → ${sliceByWidth(first, 100)}`, C.dim)
        },
        onPermissionRequest: (name, args) => askPermission(name, args),
        onTaskUpdate: (items) => {
          state.tasks = items
          const done = items.filter((i) => i.status === "done").length
          pushLine(`  [task] ${done}/${items.length}`, C.dim)
          render()
        },
      })
      flushStream()
    } catch (error) {
      flushStream()
      pushLine(`[error] ${error.message}`, C.error)
    }

    state.processing = false
    state.status = "Ready"
    render()
  }

  function flushStream() {
    if (state.streaming) {
      pushLine(state.streaming, C.assistant)
      state.streaming = ""
    }
  }

  function askPermission(name, args) {
    return new Promise((resolve) => {
      state.permission = { name, args, resolve }
      state.status = `Waiting: ${name}`
      render()
    })
  }

  // ---------------------------------------------------------- 斜杠命令

  const SLASH_COMMANDS = [
    { name: "/help", desc: "命令列表" },
    { name: "/model", desc: "查看/切换模型" },
    { name: "/config", desc: "查看当前配置" },
    { name: "/distill", desc: "从会话提取知识" },
    { name: "/clear", desc: "清屏" },
    { name: "/exit", desc: "退出" },
  ]

  async function handleSlash(text) {
    const [cmd, ...rest] = text.split(/\s+/)
    switch (cmd) {
      case "/clear":
        state.lines = []
        state.streaming = ""
        render()
        return
      case "/exit":
        cleanup()
        process.exit(0)
        return
      case "/distill":
        await runDistill()
        return
      case "/model": {
        const arg = rest[0]
        if (!arg) {
          pushLabel(`❯ Model`, ansi.bold + C.tool)
          pushLine(`model:   ${agent.provider.model}`, C.dim)
          pushLine(`baseURL: ${agent.provider.baseURL}`, C.dim)
          pushLine(`切换: /model <名称>（仅本次会话；永久修改请编辑 ~/.thincoder/config.json）`, C.dim)
          // 拉取端点可用模型列表
          pushLine(`正在拉取可用模型...`, C.dim)
          try {
            const { listModels } = await import("./provider.mjs")
            const models = await listModels(agent.provider)
            pushLabel(`❯ Available (${models.length})`, ansi.bold + C.tool)
            for (const m of models) {
              pushLine(`  ${m === agent.provider.model ? "▸ " : "  "}${m}`, m === agent.provider.model ? C.tool : C.dim)
            }
          } catch (error) {
            pushLine(`  (拉取失败: ${error.message})`, C.error)
          }
        } else {
          agent.provider.model = arg
          pushLabel(`❯ Model`, ansi.bold + C.tool)
          pushLine(`已切换到 ${arg}（仅本次会话）`, C.tool)
        }
        return
      }
      case "/config": {
        pushLabel(`❯ Config`, ansi.bold + C.tool)
        pushLine(`provider: ${agent.provider.baseURL} | model: ${agent.provider.model}`, C.dim)
        pushLine(`apiKey: ${maskKey(agent.provider.apiKey)}`, C.dim)
        const ac = agent.config?.agent ?? {}
        pushLine(`agent: maxTurns=${ac.maxTurns ?? 50} | compactThreshold=${ac.compactThreshold ?? 100000}`, C.dim)
        pushLine(`memory: ${agent.memory ? "enabled" : "disabled"}${agent.memory?.embedder ? " + vector" : " (FTS only)"}`, C.dim)
        return
      }
      case "/help": {
        pushLabel(`❯ Commands`, ansi.bold + C.tool)
        for (const c of SLASH_COMMANDS) pushLine(`  ${c.name.padEnd(10)} ${c.desc}`, C.dim)
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
    // 权限确认态：只认 y/n
    if (state.permission) {
      const answer = (str || "").toLowerCase()
      if (answer === "y" || answer === "n" || key.name === "escape") {
        const { resolve } = state.permission
        state.permission = null
        state.status = "Processing..."
        resolve(answer === "y")
        render()
      }
      return
    }

    if (key.ctrl && key.name === "c") {
      cleanup()
      process.exit(0)
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

    // 可打印字符 / 粘贴（str 可能一次多个字符）
    if (str && !key.ctrl && !key.meta) {
      const chars = [...str.replace(/\r/g, "")]
      state.input.splice(state.cursor, 0, ...chars)
      state.cursor += chars.length
      render()
    }
  })

  // 启动画面
  pushLine(`Welcome to ThinCoder. Model: ${agent.provider.model}`, C.dim)
  pushLine(`Tools: ${agent.tools.map((t) => t.name).join(", ")}`, C.dim)
  render()
}

function summarize(obj) {
  const s = JSON.stringify(obj)
  return s.length > 80 ? s.slice(0, 80) + "…" : s
}
