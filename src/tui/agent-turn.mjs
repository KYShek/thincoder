import { runAgent, ContinueError } from "../agent.mjs"
import { saveSession } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

/** Execute one agent conversation turn (triggered by submit or queue).
 *  Extracted from index.mjs: agent loop + callback construction + error handling + queue processing.
 *  ctx: { agent, state, pushLine, pushLabel, render, scheduleRender,
 *         ensureAssistantLabel, askPermission, askQuestion,
 *         handleSlash, summarize } */
export async function runAgentTurn(ctx, text) {
  const { agent, state, pushLine, pushLabel, render, scheduleRender, ensureAssistantLabel, askPermission, askQuestion, handleSlash, summarize } = ctx
  // 可注入覆盖（测试用）；默认走真实实现
  const runAgentImpl = ctx.runAgent ?? runAgent
  const saveSessionImpl = ctx.saveSession ?? saveSession
  pushLabel(`❯ You:`, ansi.bold + C.user)
  pushLine(text, C.text)

  // Auto-checkpoint before task (git repo only; failure is silent, doesn't block the task)
  try {
    const { createCheckpoint } = await import("../git/checkpoint.mjs")
    await createCheckpoint(agent.cwd)
  } catch {
    // Checkpoint failure doesn't block the task
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
  state.interruptPrompt = null
  // Refresh status bar every second during processing (elapsed timer)
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
      // Subagent streaming: prefix format role#id/ → extract id, update subTask streaming text
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
      // Subagent reasoning tokens also carry role#id/ prefix, go into subTasks panel
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
      // Subagent tool call: prefix role#id/toolName → update subTask current tool
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
      // Subagent complete: mark earliest running subTask as done
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
        // Subagent report preview (max 8 lines) displayed directly in conversation
        const lines = result.split("\n")
        const preview = lines.slice(0, 8).map((l) => l.slice(0, 120)).join("\n")
        if (preview) pushLine(preview, C.dim)
        if (lines.length > 8) pushLine(`  ... (${lines.length - 8} more lines)`, C.dim)
        // Clear done entries from panel after 3 seconds
        setTimeout(() => {
          for (const key of Object.keys(state.subTasks)) {
            if (state.subTasks[key].done) delete state.subTasks[key]
          }
          if (state.processing) render()
        }, 3000)
      }
      const stream = state.toolStreams[name]
      const panel = state.outputPanels[name]
      if (panel) {
        delete state.toolStreams[name]
        panel.done = true
        // Advisor: push full review into conversation (output panel is transient)
        if (name === "advisor") {
          const text = String(result ?? "")
          const lines = text.split("\n")
          const maxShow = Math.min(24, lines.length)
          for (let i = 0; i < maxShow; i++) pushLine(`  ${lines[i].slice(0, 160)}`, C.dim)
          if (lines.length > maxShow) pushLine(`  ... (${lines.length - maxShow} more lines)`, C.dim)
        } else {
          const summary = formatPanelSummary(name, result)
          if (summary) pushLine(`  ${summary}`, C.dim)
        }
        setTimeout(() => {
          delete state.outputPanels[name]
          if (state.processing) render()
        }, 3000)
      } else if (stream) {
        const tail = stream.trimEnd().slice(-4000)
        if (tail) pushLine(tail, C.dim)
        delete state.toolStreams[name]
      }
      if (!isSubagent && !panel) {
        const first = result.split("\n")[0]
        pushLine(`  [done] ${name} → ${sliceByWidth(first, 100)}`, C.dim)
      }
    },
    onToolOutput: (name, chunk) => {
      // Route streaming output to a panel if one exists or was requested via outputPanel flag.
      let panel = state.outputPanels[name]
      if (!panel) {
        // Lazy-create panel: defensive against race conditions where setupOutputPanel
        // hasn't fired yet or the callbacks chain dropped it (subagent relay, reconnect, etc.)
        state.outputPanels[name] = { text: "", done: false }
        panel = state.outputPanels[name]
      }
      panel.text = (panel.text ?? "") + chunk
      if (panel.text.length > 4000) panel.text = panel.text.slice(-4000)
      scheduleRender()
    },
    onPermissionRequest: (name, args) => askPermission(name, args),
    onQuestion: (text, options) => askQuestion(text, options),
    setupOutputPanel: (name) => {
      state.outputPanels[name] = { text: "", done: false }
      scheduleRender()
    },
    onCompress: () => {
      pushLine("  [context] Context too long, auto-compacted (early conversation summarized by LLM, task state preserved)", C.warn)
    },
    onUsage: (usage) => {
      state.tokens.prompt += usage.prompt_tokens ?? 0
      state.tokens.completion += usage.completion_tokens ?? 0
      state.tokens.cacheHit += usage.prompt_cache_hit_tokens ?? 0
      state.tokens.cacheMiss += usage.prompt_cache_miss_tokens ?? 0
      state.tokens.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    // Throttle wait (active gate / 429 backoff): show in status bar so user knows it's not frozen
    onWait: ({ phase, seconds }) => {
      if (phase === "gate") state.status = `TPM throttle wait ~${seconds}s`
      else if (phase === "overloaded") state.status = `Server overloaded, retrying in ${seconds}s`
      else state.status = `Rate-limited 429, retry in ${seconds}s`
      render()
    },
    onTaskUpdate: (items) => {
      state.tasks = items
      const done = items.filter((i) => i.status === "done").length
      // Leave trace with current task title: reviewing history shows what was in progress
      const current = items.find((i) => i.status === "in_progress")
      pushLine(`  [task] ${done}/${items.length}${current ? ` ▶ ${current.title}` : ""}`, C.dim)
      render()
    },
    // Incremental save: flush to disk every 5 tool turns — mid-crash loss window shrinks from an entire round to a few turns
    onTurnEnd: (() => {
      let n = 0
      return () => {
        if (++n % 5 !== 0) return
        try { saveSessionImpl(agent, state.lines) } catch (e) { console.error(`[session] incremental save failed: ${e.message}`) }
      }
    })(),
  }

  // try/finally: every exit path — including an unexpected throw inside the catch
  // block (e.g. the continue-permission UI) — must stop the ticker and reset state,
  // otherwise the 1s render interval leaks and keeps firing forever.
  try {
    for (let resume = false; ; resume = true) {
      try {
        await runAgentImpl(agent, text, callbacks, { signal: state.controller.signal, resume })
        flushStream()
        break // Normal completion, exit loop
      } catch (error) {
        flushStream()
        if (error.name === "AbortError" || state.controller?.signal.aborted) {
          // Ctrl+I inject: the signal was aborted with an interrupt message — the agent loop
          // may have already injected it into history, but the aborted signal prevents retry.
          // Recreate the controller and resume from the same context.
          if (state.controller?.signal?.reason?.interrupt) {
            state.controller = new AbortController()
            resume = true
            continue
          }
          pushLine("[stopped]", C.warn)
          break
        }
        if (error instanceof ContinueError) {
          pushLabel(`❯ Continue`, ansi.bold + C.warn)
          pushLine(`Ran ${error.turn} turns (limit ${error.turn}). Continue?`, C.warn)
          // Pause to ask: reuse permission mechanism
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
          // Recreate AbortController: once aborted, resume immediately fails (defensive; current path unreachable but tightly coupled)
          state.controller = new AbortController()
          continue
        }
        pushLine(`[error] ${error.message}`, C.error)
        break
      }
    }
  } finally {
    clearInterval(ticker)
    state.processing = false
    state.subTasks = {}
    state.controller = null
    state.status = "Ready"
    // Auto-collapse todo panel when all tasks done (matching kimi-code TUI; agent.tasks are preserved)
    if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
      state.tasks = []
    }
    // Save session after every turn (survives crashes)
    try {
      saveSessionImpl(agent, state.lines)
    } catch {
      // Save failure doesn't interrupt usage
    }
    render()
  }

  // Queued messages: auto-process next one
  while (state.queue.length > 0 && !state.processing) {
    const next = state.queue.shift()
    // Queued slash commands execute directly — check every item, not just the first
    if (next.text.startsWith("/")) {
      await handleSlash(next.text)
      render()
      continue
    }
    pushLabel(`❯ You: (from queue)`, ansi.bold + C.user)
    await runAgentTurn(ctx, next.text)
    return
  }
}

/** Extract a one-line summary from a panel tool's output */
function formatPanelSummary(name, result) {
  if (name === "verify") return _verifySummary(result)
  // Default: first non-empty line
  const first = result.split("\n").find((l) => l.trim())
  return first ? `${name}: ${first.slice(0, 100)}` : null
}

function _verifySummary(result) {
  const lines = result.split("\n")
  const summary = []
  // Changed files count
  const changed = lines.find((l) => l.startsWith("Changed files:"))
  if (changed) {
    const m = changed.match(/files changed/) ? changed.replace(/^Changed files \(.*?\)/, "Changed files") : changed
    summary.push(m)
  }
  // Syntax check results
  const syntax = lines.filter((l) => l.startsWith("  ✗"))
  if (syntax.length > 0) {
    summary.push(`${syntax.length} syntax error(s)`)
  }
  // Test results
  const testLine = lines.find((l) => l.startsWith("✓ Tests passed.") || l.startsWith("✗ Tests FAILED"))
  if (testLine) summary.push(testLine.trim())
  // Task list
  const taskLine = lines.find((l) => l.startsWith("Task list:"))
  if (taskLine) summary.push(taskLine)
  return summary.length > 0 ? `verify: ${summary.join(" — ")}` : ""
}
