/**
 * tui.mjs — 裸 ANSI 终端 UI
 * 零依赖：raw mode 键盘输入、ANSI 转义渲染、自研宽字符换行。
 * 布局：header / 对话区 (可滚动）/ todo 面板 (有任务时）/ 输入框 / 状态栏。
 */

import { emitKeypressEvents } from "node:readline"
import { PassThrough } from "node:stream"
import { basename } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { runAgent, ContinueError } from "../agent.mjs"
import { saveSession, clearSession, archiveCurrent, listSlots, switchToSlot, sessionPath, applySession } from "../session.mjs"
import { closeAllMcp } from "../mcp.mjs"
import {
  charWidth, stringWidth, sliceByWidth, formatTables,
  layoutInput, sanitizeDisplay, wrapText,
} from "./render.mjs"
import { ansi, C, ESC } from "./ansi.mjs"
import { renderFrame } from "./render-frame.mjs"
import { SLASH_COMMANDS, createSlashCommands } from "./slash-commands.mjs"
import { createWizard } from "./wizard.mjs"
import { createPickers } from "./pickers.mjs"
import { runDistillCmd } from "./distill-cmd.mjs"
import { createInteraction } from "./interaction.mjs"
import { pasteClipboardImage as pasteClipboardImageImpl } from "./clipboard.mjs"

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
    const { frame, cursorRow, cursorCol } = renderFrame(state, agent, {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
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


  // 交互原语：权限审批 + 问答输入，实现在 interaction.mjs
  const { askPermission, askQuestion } = createInteraction({
    agent, state, pushLine, pushLabel, render, summarize,
  })

  // 剪贴板图片粘贴：实现在 clipboard.mjs
  const pasteClipboardImage = () => pasteClipboardImageImpl({ agent, state, pushLine, render })

  /** 执行一轮 agent 对话（从 submit 或队列取出调用） */
  async function runAgentTurn(text) {
    pushLine(text, C.text)

    // 任务开始前自动打存档点 (git 仓库内；失败静默，不挡任务）
    try {
      const { createCheckpoint } = await import("../git/checkpoint.mjs")
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
        state.status = phase === "gate" ? `TPM throttle wait ~${seconds}s` : `Rate-limited 429, retry in ${seconds}s`
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


  // ---------------------------------------------------------- 斜杠Commands

  // persistRaw / syncProviderField / maskKey 供 slash-commands.mjs 与 wizard/model-picker 共用
  async function persistRaw(mutate) {
    const { saveConfig, configPath } = await import("../config.mjs")
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    saveConfig(raw)
  }

  async function syncProviderField(field, value) {
    const target = agent.providers.find((p) => p.name === agent.activeProvider)
    if (!target) return
    if (value === undefined) delete target[field]
    else target[field] = value
    await persistRaw((raw) => {
      raw.providers = agent.providers
    })
  }

  function maskKey(key) {
    if (!key) return "(none)"
    if (key.length <= 8) return "***"
    return key.slice(0, 5) + "\u2026" + key.slice(-4)
  }

  // ---------------------------------------------------------- 模型选择器 + 通用 picker：实现在 pickers.mjs
  const { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey } = createPickers({
    agent, state, render, ansi, C, pushLine, pushLabel, persistRaw, askQuestion,
  })

  // 初始 Config 向导：实现在 wizard.mjs，通过 ctx 传入闭包依赖
  const { startWizard, renderWizard, wizardChooseProvider, wizardSubmitText, cancelWizard } = createWizard({
    agent, state, pushLine, pushLabel, render, persistRaw,
    openModelPicker: () => openModelPicker(),
  })

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

  /** /distill: impl in distill-cmd.mjs, ctx-passed */
  const runDistill = () => runDistillCmd({ agent, state, pushLine, render, askPermission, distillOpts })

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
          pushLine(`  [auto] AUTO ON: tool calls no longer prompt for approval (/auto to disable)`, C.warn)
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
      const items = state.picker?.entries.filter((e) => e.type === "item") ?? []
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
    pushLine("No API key configured yet — entering initial setup (Esc to skip anytime)", C.text)
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
    const { codeSync, docSync, gitSync } = await import("../memory.mjs")
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
