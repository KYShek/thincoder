import { runAgent, ContinueError } from "../agent.mjs"
import { saveSession } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

/** Tool execution start timestamps (performance.now ms), keyed by tool name. */
const _toolTicks = Object.create(null)
/** Streamed-output line counters for inline blocks (cap at 5 preview lines). */
const _toolLines = Object.create(null)

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
      // Advisor: tag the round in the tool title — the model's own "第N轮" narration
      // is unreliable (it glues onto the previous line), so the round belongs here.
      const roundTag = name === "advisor" ? ` (round ${(agent._advisorRound || 0) + 1})` : ""
      const argSummary = summarize(args)
      // Inline block title — panel tools get both the title AND the
      // streaming output panel, complementary display.
      const color = ({ advisor: C.advisor, bash: C.warn, verify: C.tool }[name] ?? C.text)
      pushLine(`❯ ${name}${roundTag}${argSummary ? ` ${argSummary}` : ""}`, color)
      _toolTicks[name] = performance.now()
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
      if (name === "advisor") {
        // Remove live streaming lines — done line handles the summary.
        for (let i = state.lines.length - 1; i >= 0; i--) {
          if (state.lines[i]._live === "advisor") state.lines.splice(i, 1)
        }
      } else if (!isSubagent) {
        const summary = formatToolSummary(name, result)
        if (summary) pushLine(`  ${summary}`, C.dim)
      }
      // Done line for ALL tools (panel area abolished — inline only).
      if (!isSubagent) {
        const elapsed = _toolTicks[name] ? ` (${Math.round(performance.now() - _toolTicks[name])}ms)` : ""
        const summary = formatToolSummary(name, result)
        const tail = summary ? ` → ${sliceByWidth(summary, 60)}` : ""
        pushLine(`❯ ${name} — done${elapsed}${tail}`, C.dim)
      }
      delete _toolTicks[name]
      delete _toolLines[name]
    },
    onToolOutput: (name, chunk) => {
      // All tools use inline conversation blocks — panel area is abolished.
      // Stream up to 5 preview lines; the full result is in the tool message.
      const part = typeof chunk === "string"
        ? { kind: "text", text: chunk.trimEnd() }
        : { kind: chunk?.kind ?? "text", text: String(chunk?.text ?? "").trimEnd() }
      if (!part.text) return
      if (name === "advisor") {
        // Live streaming with kind-aware coloring: think (dim), tool calls (cyan),
        // review text (bright green). Chunks without \n append to the previous
        // same-kind line so tokens flow together. \n in a chunk means "start a new
        // line" — segments after the first \n always begin fresh lines.
        const color = part.kind === "think" ? C.reason
          : part.kind === "tool" ? C.tool
          : C.advisor
        const appendable = part.kind !== "tool"
        const segments = part.text.split("\n")
        for (let i = 0; i < segments.length; i++) {
          const trimmed = segments[i].trimEnd()
          if (!trimmed) continue
          if (appendable && i === 0) {
            // First segment — append to previous same-kind line if one exists.
            const last = state.lines.filter(l => l._live === "advisor").at(-1)
            if (last && last._kind === part.kind) {
              last.text += trimmed
            } else {
              state.lines.push({ text: `  ${trimmed}`, color, _live: "advisor", _kind: part.kind })
            }
          } else {
            // After a \n, or tool chunk — always a new line.
            const prefix = part.kind === "tool" ? "" : "  "
            state.lines.push({ text: `${prefix}${trimmed}`, color, _live: "advisor", _kind: part.kind })
          }
        }
        // Prune overflow: keep at most 20 advisor streaming lines
        let count = 0
        for (let i = state.lines.length - 1; i >= 0; i--) {
          if (state.lines[i]._live === "advisor") {
            if (++count > 20) state.lines.splice(i, 1)
          }
        }
        scheduleRender()
        return
      }
      const count = (_toolLines[name] = (_toolLines[name] ?? 0) + 1)
      if (count <= 5) {
        const color = ({ think: C.reason, tool: C.tool }[part.kind] ?? C.dim)
        pushLine(`  │ ${sliceByWidth(part.text, 120)}`, color)
      } else if (count === 6) {
        pushLine(`  │ …`, C.dim)
      }
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
        // Flush pending reasoning/streaming before the next turn starts.
        // Guard pushbacks (verify/advisor) continue the agent loop without
        // returning to the TUI — without flushing, old thinking bleeds into
        // the next turn and the guard reminder is invisible.
        flushStream()
        // Mirror the last system-reminder from agent.history so guard
        // pushback messages appear in the conversation at the right spot.
        const last = agent.history.at(-1)
        if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[System reminder:")) {
          pushLine(last.content, C.warn)
        }
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

/** Extract a one-line summary from tool output for the done line */
function formatToolSummary(name, result) {
  if (name === "verify") return _verifySummary(result)
  if (name === "bash") return _bashSummary(result)
  if (name === "advisor") return _advisorSummary(result)
  // Default: first non-empty line
  const first = result.split("\n").find((l) => l.trim())
  return first ? `${name}: ${first.slice(0, 100)}` : null
}

/**
 * bash result format: "[stdout]:\n<out>\n\n[stderr]:\n<err>\n\n(exit code 0)".
 * The first non-empty line is always the "[stdout]:" marker — useless as a summary.
 * Show the LAST output line (usually the meaningful tail) plus the exit status.
 */
function _bashSummary(result) {
  const isMarker = (l) => /^\[(stdout|stderr)\]:$/.test(l) || /^\((exit code|killed)/.test(l)
  const lines = result.split("\n").map((l) => l.trim()).filter((l) => l && !isMarker(l))
  const status = result.match(/\((?:exit code|killed)[^)]*\)/)?.[0]
  const parts = []
  if (lines.length > 0) parts.push(lines[lines.length - 1].slice(0, 100))
  if (status) parts.push(status)
  return parts.length > 0 ? `bash: ${parts.join(" ")}` : null
}

function _advisorSummary(result) {
  const text = String(result ?? "")
  if (text.includes("CODE_REVIEW_PASSED")) return "advisor: passed"
  const critical = (text.match(/\| \d+ \|.*\| 🔴/g) || []).length
  const advisory = (text.match(/\| \d+ \|.*\| 🟡/g) || []).length
  const style = (text.match(/\| \d+ \|.*\| 🔵/g) || []).length
  const parts = []
  if (critical) parts.push(`${critical} critical`)
  if (advisory) parts.push(`${advisory} advisory`)
  if (style) parts.push(`${style} style`)
  if (parts.length === 0) return null
  return `advisor: ${parts.join(", ")}`
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
