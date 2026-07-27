import { listSlots } from "../session.mjs"
import { sliceByWidth } from "./render.mjs"
import { ansi, C } from "./ansi.mjs"

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
    // Rebuild conversation: user/assistant messages shown one by one, tool result lines show only first-line summary
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
          // Find the next corresponding tool result, show first-line summary
          const toolResult = opts.restored.history[i + 1]
          const hasResult = toolResult?.role === "tool" && toolResult?.tool_call_id === tc.id
          const summary = hasResult ? " → " + sliceByWidth(String(toolResult.content).split("\n")[0], 80) : ""
          pushLine(`  [tool] ${tc.function?.name ?? "?"}${summary}`, C.tool)
        }
      }
      // Tool messages aren't rendered separately — already shown as summary after assistant's tool_calls
    }
    pushLabel(`── Restored previous session (${opts.restored.history.length} messages); /new for a fresh session ──`, C.warn)
  }

  // Hint when archived slots exist
  if (listSlots(agent.cwd).length > 0) {
    pushLine("Tip: archived sessions available — /session to view/switch", C.dim)
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
