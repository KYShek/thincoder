import { runAgent, ContinueError } from "../agent.mjs"
import { saveSession } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

/** 执行一轮 agent 对话（从 submit 或队列取出调用）。
 *  从 index.mjs 抽出：agent 循环 + 回调构建 + 错误处理 + 队列处理。
 *  ctx: { agent, state, pushLine, pushLabel, render, scheduleRender,
 *         ensureAssistantLabel, askPermission, askQuestion,
 *         handleSlash, summarize } */
export async function runAgentTurn(ctx, text) {
  const { agent, state, pushLine, pushLabel, render, scheduleRender, ensureAssistantLabel, askPermission, askQuestion, handleSlash, summarize } = ctx
  pushLabel(`❯ You:`, ansi.bold + C.user)
  pushLine(text, C.text)

  // 任务开始前自动打存档点 (git 仓库内；失败静默，不挡任务）
  try {
    const { createCheckpoint } = await import("../git/checkpoint.mjs")
    await createCheckpoint(agent.cwd)
  } catch {
    // 存档失败不影响任务
  }

  ctx.assistantLabeled = false
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

  const flushStream = () => {
    if (state.reasoning) {
      pushLine(state.reasoning, C.reason)
      state.reasoning = ""
    }
    if (state.streaming) {
      pushLine(state.streaming, C.text)
      state.streaming = ""
    }
  }

  const callbacks = {
    onToken: (t) => {
      // 子 agent 流式输出：前缀格式 role#id/ → 提取 id，更新对应 subTask 的流式文本
      const subMatch = t.match(/^(\w+)#(\d+)\//)
      if (subMatch) {
        const key = `${subMatch[1]}#${subMatch[2]}`
        const payload = t.slice(subMatch[0].length)
        if (!state.subTasks[key]) {
          state.subTasks[key] = { key, role: subMatch[1], text: "", tool: null, done: false, started: Date.now() }
        }
        state.subTasks[key].text += payload
        if (state.subTasks[key].text.length > 2000) {
          state.subTasks[key].text = state.subTasks[key].text.slice(-2000)
        }
        scheduleRender()
        return
      }
      ensureAssistantLabel()
      state.streaming += t
      scheduleRender()
    },
    onReasoning: (t) => {
      // 子 agent 的思考 token 同样带 role#id/ 前缀，进 subTasks 面板
      const subMatch = t.match(/^(\w+)#(\d+)\//)
      if (subMatch) {
        const key = `${subMatch[1]}#${subMatch[2]}`
        if (!state.subTasks[key]) {
          state.subTasks[key] = { key, role: subMatch[1], text: "", tool: null, done: false, started: Date.now() }
        }
        scheduleRender()
        return
      }
      ensureAssistantLabel()
      state.reasoning += t
      scheduleRender()
    },
    onToolCall: (name, args) => {
      // 子 agent 工具调用：前缀 role#id/toolName → 更新对应 subTask 的当前工具
      const subMatch = name.match(/^(\w+)#(\d+)\//)
      if (subMatch) {
        const key = `${subMatch[1]}#${subMatch[2]}`
        const toolName = name.slice(subMatch[0].length)
        if (!state.subTasks[key]) {
          state.subTasks[key] = { key, role: subMatch[1], text: "", tool: null, done: false, started: Date.now() }
        }
        state.subTasks[key].tool = toolName
        state.subTasks[key].toolArgs = args
        state.subTasks[key].text = ""
        scheduleRender()
        return
      }
      flushStream()
      ensureAssistantLabel()
      state.currentTool = name
      pushLine(`  [tool] ${name} ${summarize(args)}`, C.tool)
    },
    onToolResult: (name, result) => {
      state.currentTool = null
      // 子 agent 结束：标记最早创建的 running subTask 为 done
      const isSubagent = name === "subagent"
      if (isSubagent) {
        const running = Object.entries(state.subTasks)
          .filter(([, s]) => !s.done)
          .sort(([, a], [, b]) => a.started - b.started)
        if (running.length > 0) {
          const [key] = running[0]
          state.subTasks[key].done = true
          state.subTasks[key].tool = null
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
        await runAgentTurn(ctx, next2.text)
      }
    } else {
      pushLabel(`❯ You: (from queue)`, ansi.bold + C.user)
      await runAgentTurn(ctx, next.text)
    }
  }
}
