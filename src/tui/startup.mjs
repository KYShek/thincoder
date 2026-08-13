import { listSlots } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

/** Lazy history window (parity with VS Code HISTORY_PAGE_SIZE): first paint loads
 *  the latest INITIAL_HISTORY_MESSAGES, then PgUp-at-top loads HISTORY_PAGE_MESSAGES
 *  more. Rebuilding an 8000-message session eagerly froze startup + first render. */
export const INITIAL_HISTORY_MESSAGES = 200
export const HISTORY_PAGE_MESSAGES = 50

/**
 * Convert history[startIdx, endIdx) into conversation source lines (label lines
 * with a leading blank separator, content lines, tool summaries). `history` is the
 * FULL array so the tool-result lookahead (history[i+1]) works across the page edge.
 */
export function historyToLines(history, startIdx, endIdx) {
  const lines = []
  for (let i = startIdx; i < endIdx; i++) {
    const m = history[i]
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.startsWith("[System reminder:")) continue
      if (lines.length > 0) lines.push({ text: "", color: C.dim })
      lines.push({ text: "❯ You:", color: ansi.bold + C.user })
      if (typeof m.content === "string" && m.content) lines.push({ text: m.content, color: C.text })
    } else if (m.role === "assistant") {
      if (lines.length > 0) lines.push({ text: "", color: C.dim })
      lines.push({ text: "❯ ThinCoder:", color: ansi.bold + C.assistant })
      if (typeof m.content === "string" && m.content) lines.push({ text: m.content, color: C.text })
      for (const tc of m.tool_calls ?? []) {
        const toolResult = history[i + 1]
        const hasResult = toolResult?.role === "tool" && toolResult?.tool_call_id === tc.id
        const summary = hasResult ? " → " + sliceByWidth(String(toolResult.content).split("\n")[0], 80) : ""
        lines.push({ text: `  [tool] ${tc.function?.name ?? "?"}${summary}`, color: C.tool })
      }
    }
  }
  return lines
}

/** Startup screen + session recovery + background indexing.
 *  Extracted from index.mjs.
 *  ctx: { agent, state, opts, pushLine, pushLabel, render, startWizard } */
export function showStartup(ctx) {
  const { agent, state, opts, pushLine, pushLabel, render, startWizard } = ctx

  // Startup screen
  if (!agent.provider.apiKey) {
    pushLabel(`Welcome to ThinCoder!`, ansi.bold + C.tool)
    pushLine("No API key configured yet — entering initial setup (Esc to skip anytime)", C.text)
    startWizard()
  } else {
    pushLine(`Welcome to ThinCoder. Provider: ${agent.activeProvider} / ${agent.provider.model}`, C.dim)
  }
  pushLine(`Tools: ${agent.tools.map((t) => t.name).join(", ")}`, C.dim)

  // Recover previous session: rebuild conversation display (tool result lines omitted, keep it clean)
  if (opts.restored?.display?.length) {
    // User-facing recovery: display is a WYSIWYG snapshot of the conversation before exit
    state.lines = [...opts.restored.display.map((l) => ({ text: l.text, color: l.color })), ...state.lines]
    const recoveryNote = opts.restored._recovered ? " (recovered from backup)" : ""
    pushLabel(`── Restored previous session${recoveryNote}; /new for a fresh session ──`, C.warn)
  } else if (opts.restored?.history?.length) {
    // Lazy rebuild: only the latest INITIAL_HISTORY_MESSAGES are materialized on
    // startup; the rest loads on demand (PgUp at top). state._history* fields are
    // read by the loadOlder closure in index.mjs.
    const total = opts.restored.history.length
    const start = Math.max(0, total - INITIAL_HISTORY_MESSAGES)
    state.lines.push(...historyToLines(opts.restored.history, start, total))
    state._historyLoaded = total - start
    state._historyTotal = total
    state._hasOlder = start > 0
    if (state._hasOlder) {
      state.lines.unshift({ text: `… ${start} more earlier messages (PgUp at top to load)`, color: C.dim })
    }
    pushLabel(`── Restored previous session (${total} messages); /new for a fresh session ──`, C.warn)
  }

  // Hint when multiple sessions exist
  const allSlots = listSlots(agent.cwd)
  if (allSlots.length > 1) {
    pushLine(`Tip: ${allSlots.length} sessions — /session to view/switch`, C.dim)
  }
  render()
}

/** Background indexing (runs after startup screen, non-blocking); progress shown in status bar, not conversation.
 *   Prefers git diff incremental (fast); falls back to full scan when git is unavailable or on first run. */
export async function backgroundIndex(ctx) {
  const { agent, state, render } = ctx
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
    // Git incremental succeeded, count directly
    codeFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM code_chunks`).get()?.n ?? 0
    docFiles = agent.memory.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM doc_chunks`).get()?.n ?? 0
  } else {
    // Fall back to full scan (codeSync and docSync in parallel — read/write different tables, SQLite WAL supports this natively)
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
}
