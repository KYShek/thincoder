/**
 * tui.mjs — 裸 ANSI 终端 UI
 * 零依赖：raw mode 键盘输入、ANSI 转义渲染、自研宽字符换行。
 * 布局：header / 对话区 (可滚动）/ todo 面板 (有任务时）/ 输入框 / 状态栏。
 *
 * 大型逻辑块已拆到独立模块：
 *   agent-turn.mjs    — agent 循环 + 回调构建
 *   key-handler.mjs   — 键盘事件分发
 *   startup.mjs       — 启动画面 + 会话恢复 + 后台索引
 *   interaction.mjs   — 权限审批 + 问答
 *   pickers.mjs       — 通用列表选择器 + 模型选择器
 *   wizard.mjs        — 首次配置向导
 *   slash-commands.mjs — 斜杠命令分发
 *   config-helpers.mjs — persistRaw / syncProviderField / maskKey
 *   clipboard.mjs     — 剪贴板图片粘贴
 *   distill-cmd.mjs   — /distill 命令
 */

import { emitKeypressEvents } from "node:readline"
import { PassThrough } from "node:stream"
import { saveSession, archiveCurrent, listSlots } from "../session.mjs"
import { closeAllMcp } from "../mcp.mjs"
import { estimateTokens } from "../context.mjs"
import { ansi, C } from "./ansi.mjs"
import { renderFrame, countConvLines } from "./render-frame.mjs"
import { computeLayout } from "./layout.mjs"
import { SLASH_COMMANDS, createSlashCommands } from "./slash-commands.mjs"
import { createWizard } from "./wizard.mjs"
import { createPickers } from "./pickers.mjs"
import { runDistill as runDistillImpl } from "./distill-cmd.mjs"
import { createInteraction } from "./interaction.mjs"
import { pasteClipboardImage as pasteClipboardImageImpl } from "./clipboard.mjs"
import { runAgentTurn } from "./agent-turn.mjs"
import { createKeyHandler } from "./key-handler.mjs"
import { showStartup, backgroundIndex } from "./startup.mjs"
import { createConfigHelpers } from "./config-helpers.mjs"

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

  function scheduleRender() {
    if (renderTimer) return
    renderTimer = setTimeout(() => {
      renderTimer = null
      render()
    }, 40)
  }

  function render() {
    // 副作用：scroll 归位 + ctxCache 更新 + overlay scroll 归位
    // (renderFrame 是纯函数，副作用集中在此)
    const dims = { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }
    const layout = computeLayout(state, dims)
    // clamp conversation scroll
    const convLines = countConvLines(state, dims.cols)
    const maxScroll = Math.max(0, convLines - layout.panels.conversation.h)
    state.scroll = Math.min(state.scroll, maxScroll)
    // clamp overlay scroll
    const overlay = state.picker ?? state.wizard
    if (overlay && layout.panels.picker) {
      const winH = layout.panels.picker.h - 1
      if (overlay.selectedLine < overlay.scroll) overlay.scroll = overlay.selectedLine
      if (overlay.selectedLine >= overlay.scroll + winH) overlay.scroll = overlay.selectedLine - winH + 1
    }
    // update ctxCache
    if (state.ctxCache.len !== agent.history.length) {
      state.ctxCache = { len: agent.history.length, tokens: estimateTokens(agent.history) }
    }

    const { frame, cursorRow, cursorCol } = renderFrame(state, agent, {
      ...dims,
      slashCommands: SLASH_COMMANDS,
    })
    if (frame !== lastFrame) {
      lastFrame = frame
      process.stdout.write(frame)
    }
    // 光标：输入态定位到输入框内；权限确认/菜单态时隐藏
    if (state.permission || state.question || state.picker || state.wizard?.step === "provider") {
      process.stdout.write(ansi.hideCursor)
    } else {
      process.stdout.write(`${"\x1b"}[${cursorRow};${cursorCol}H${ansi.showCursor}`)
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
        const safeDuringProcessing = new Set(["/help", "/exit", "/model", "/think", "/config", "/skills", "/mcp", "/goal", "/session"])
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

    await turn(text)
  }

  // 交互原语：权限审批 + 问答输入，实现在 interaction.mjs
  const { askPermission, askQuestion } = createInteraction({
    agent, state, pushLine, pushLabel, render, summarize,
  })

  // 剪贴板图片粘贴：实现在 clipboard.mjs
  const pasteClipboardImage = () => pasteClipboardImageImpl({ agent, state, pushLine, render })

  // agent 循环：实现在 agent-turn.mjs
  const turnCtx = {
    agent, state, pushLine, pushLabel, render, scheduleRender, ensureAssistantLabel,
    askPermission, askQuestion, handleSlash: null, summarize,
    get assistantLabeled() { return assistantLabeled },
    set assistantLabeled(v) { assistantLabeled = v },
  }
  const turn = (text) => runAgentTurn(turnCtx, text)

  // ---------------------------------------------------------- 斜杠Commands

  // 配置辅助：实现在 config-helpers.mjs
  const { persistRaw, syncProviderField, maskKey } = createConfigHelpers(agent)

  // 模型选择器 + 通用 picker：实现在 pickers.mjs
  const { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey } = createPickers({
    agent, state, render, ansi, C, pushLine, pushLabel, persistRaw, askQuestion, maskKey,
  })

  // 初始 Config 向导：实现在 wizard.mjs，通过 ctx 传入闭包依赖
  const { startWizard, renderWizard, wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems } = createWizard({
    agent, state, pushLine, pushLabel, render, persistRaw,
    openModelPicker: () => openModelPicker(),
  })

  // /distill: impl in distill-cmd.mjs, ctx-passed
  const runDistill = () => runDistillImpl({ agent, state, pushLine, render, askPermission, distillOpts })

  // 斜杠命令分发、Tab 补全：实现在 slash-commands.mjs，通过 ctx 传入闭包依赖
  const { handleSlash, completions, handleTab } = createSlashCommands({
    agent, state, distillOpts,
    pushLine, pushLabel, render,
    openPicker, askQuestion, askPermission,
    persistRaw, syncProviderField, maskKey,
    openModelPicker: () => openModelPicker(),
    setProviderKey,
    runDistill,
    exit: () => { cleanup(); setTimeout(() => process.exit(0), 100) },
  })
  // handleSlash 被 turnCtx 引用（循环依赖：submit → turn → handleSlash），在此回填
  turnCtx.handleSlash = handleSlash

  // ---------------------------------------------------------- 键盘 / 鼠标

  // keypress 挂在过滤后的 keyStream 上：鼠标序列已在上游滤网中处理并剥除
  const onKeypress = createKeyHandler({
    agent, state, render, closePicker, renderPickerLines,
    handleSlash, handleTab, submit, pasteClipboardImage,
    wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems,
    renderWizard, pushLine, cleanup,
  })
  keyStream.on("keypress", onKeypress)

  // ---------------------------------------------------------- 启动画面 + 后台索引

  showStartup({ agent, state, opts, pushLine, pushLabel, render, startWizard })
  backgroundIndex({ agent, state, render })
}

function summarize(obj) {
  const s = JSON.stringify(obj)
  return s.length > 80 ? s.slice(0, 80) + "…" : s
}
