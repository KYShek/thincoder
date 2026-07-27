/**
 * tui.mjs — bare ANSI terminal UI
 * Zero dependencies: raw mode keyboard input, ANSI escape rendering, custom wide-char wrapping.
 * Layout: header / conversation (scrollable) / todo panel (when tasks exist) / input box / status bar.
 *
 * Large logic blocks extracted to independent modules:
 *   agent-turn.mjs    — agent loop + callback construction
 *   key-handler.mjs   — keyboard event dispatch
 *   startup.mjs       — startup screen + session restore + background indexing
 *   interaction.mjs   — permission approval + Q&A
 *   pickers.mjs       — generic list picker + model picker
 *   wizard.mjs        — first-launch config wizard
 *   slash-commands.mjs — slash command dispatch
 *   config-helpers.mjs — persistRaw / syncProviderField / maskKey
 *   clipboard.mjs     — clipboard image paste
 *   distill-cmd.mjs   — /distill command
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
 * Start the TUI, taking over the terminal until exit.
 * agent: return value of createAgent
 * opts: { projectDir?, team?, author? } — used by /distill when writing to project/team layers
 */
export async function startTUI(agent, opts = {}) {
  if (!process.stdin.isTTY) {
    throw new Error("TUI requires a TTY; use 'thincoder chat' for non-interactive use")
  }

  const distillOpts = opts

  const state = {
    lines: [], // conversation lines: { text, color }
    streaming: "", // current streaming buffer
    input: [], // input buffer (codepoint array)
    cursor: 0,
    history: [],
    historyIndex: -1,
    scroll: 0, // scroll lines from bottom upward
    processing: false,
    controller: null, // AbortController for current agent run
    permission: null, // { name, args, resolve }
    permissionPreview: [], // content preview lines for permission approval (rendered above input box, without separation)
    question: null, // { text, options, resolve } — agent question tool callback
    picker: null, // model picker { entries, lines, index, scroll, selectedLine }
    wizard: null, // first-launch config wizard { step, index, scroll, selectedLine, fields, error, lines }
    tasks: agent.tasks ?? [], // task list from task tool (progress shown in status bar); carried over on session restore, auto-collapsed when all done
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }, // cumulative token usage (shown in status bar)
    ctxCache: { len: -1, tokens: 0 }, // context utilization estimate cache (estimateTokens is O(n), only recompute when history grows)
    reasoning: "", // thinking stream buffer (dimmed display)
    completion: null, // Tab completion state { candidates, index }
    toolStreams: {}, // per-tool live output (isolated by tool name, parallel tools don't interleave)
    subTasks: {}, // sub-agent panel: { roleName: { role, text, done } }, one line per role, marked done briefly after completion
    outputPanels: {}, // generic tool output panel: { toolName: { text, done } } — streamed live during execution, collapsed to summary on completion
    currentTool: null, // currently executing tool name (shown in status bar)
    processingStarted: 0, // current turn start time (status bar timer)
    status: "Ready",
    queue: [], // queued messages while processing: [{ text }], auto-dequeued when current turn finishes
  }

  // On session restore, if all tasks are completed, auto-collapse the todo panel (match runtime behavior)
  if (state.tasks.length > 0 && state.tasks.every((t) => t.status === "done")) {
    state.tasks = []
  }

  // Input stream goes through a filter: mouse sequences (scroll wheel) are intercepted and handled here,
  // stripped clean before passing to keypress parsing, preventing sequence fragments (e.g. "64;72;42M")
  // from leaking into the input box
  const keyStream = new PassThrough()
  let mousePending = "" // incomplete mouse sequence tail spanning chunks
  let lastRenderedScroll = 0
  emitKeypressEvents(keyStream)
  process.stdin.setRawMode(true)
  process.stdout.write(ansi.altBuffer + ansi.hideCursor + ansi.mouseOn + ansi.bracketedPasteOn)

  const utf8Decoder = new TextDecoder("utf-8", { fatal: false })

  let pasteMode = false
  let pasteAccum = ""

  process.stdin.on("data", (chunk) => {
    let text = mousePending + utf8Decoder.decode(chunk, { stream: true })
    mousePending = ""

    // Bracketed paste: terminal wraps pasted text in \x1b[200~ ... \x1b[201~
    // Insert pasted content directly into state.input to avoid slow char-by-char keypress render
    if (pasteMode) {
      const endIdx = text.indexOf("\x1b[201~")
      if (endIdx >= 0) {
        pasteAccum += text.slice(0, endIdx)
        pasteMode = false
        const pasted = pasteAccum.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ")
        pasteAccum = ""
        if (pasted) {
          const chars = [...pasted]
          state.input.splice(state.cursor, 0, ...chars)
          state.cursor += chars.length
          render()
        }
        text = text.slice(endIdx + 6)
      } else {
        pasteAccum += text
        return
      }
    }

    // Check for paste start (may appear mid-chunk alongside other input)
    const pasteStartIdx = text.indexOf("\x1b[200~")
    if (pasteStartIdx >= 0) {
      const before = text.slice(0, pasteStartIdx)
      const after = text.slice(pasteStartIdx + 6)
      const endIdx = after.indexOf("\x1b[201~")
      if (endIdx >= 0) {
        // Paste begin and end in the same chunk: insert pasted content directly
        const pasted = after.slice(0, endIdx).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ")
        if (pasted) {
          const chars = [...pasted]
          state.input.splice(state.cursor, 0, ...chars)
          state.cursor += chars.length
          render()
        }
        text = before + after.slice(endIdx + 6)
      } else {
        // Paste spans multiple chunks: write prefix, enter paste mode
        if (before) keyStream.write(before)
        pasteMode = true
        pasteAccum = after
        return
      }
    }

    // Scroll wheel: \x1b[<64;…M = scroll up, \x1b[<65;…M = scroll down (3 lines each)
    for (const m of text.matchAll(/\x1b\[<(\d+);\d+;\d+([Mm])/g)) {
      if (Number(m[1]) === 64) {
        state.scroll += 3
      } else if (Number(m[1]) === 65) {
        state.scroll = Math.max(0, state.scroll - 3)
      }
    }

    // Strip complete mouse sequences; keep incomplete tail for reassembly with next chunk
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
    // Save session before exit (synchronous write); archive current to a slot first, then save new — never lose data
    try {
      archiveCurrent(agent.cwd)
      saveSession(agent, state.lines)
    } catch {
      // Save failure shouldn't block exit
    }
    // Kill MCP stdio subprocesses, don't leave orphans
    try {
      closeAllMcp(agent)
    } catch {
      // Can't close? fine, process is exiting anyway
    }
    process.stdin.setRawMode(false)
    process.stdout.write(ansi.mouseOff + ansi.bracketedPasteOff + ansi.mainBuffer + ansi.showCursor + ansi.reset)
  }
  process.on("exit", cleanup)

  const pushLine = (text, color) => {
    state.lines.push({ text, color })
    if (state.lines.length > 5000) {
      state.lines.splice(0, 1000)
      state.lines.unshift({ text: `... [earlier messages trimmed — ${state.lines.length} lines remaining]`, color: C.dim })
    }
    render()
  }

  /** Message block label: blank line + label line. Breathing space between user/assistant messages */
  const pushLabel = (text, color) => {
    if (state.lines.length > 0) state.lines.push({ text: "", color: C.dim })
    state.lines.push({ text, color })
    render()
  }

  // Only emit the assistant label once per turn (on first token or first tool call)
  let assistantLabeled = false
  const ensureAssistantLabel = () => {
    if (!assistantLabeled) {
      assistantLabeled = true
      pushLabel(`❯ ThinCoder:`, ansi.bold + C.assistant)
    }
  }

  // ---------------------------------------------------------- Render

  // Frame dedup + streaming rate limit: skip re-rendering unchanged frames (prevents flicker);
  // merge token flood to ~25fps
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
    // Side effects: reset scroll + update ctxCache + clamp overlay scroll
    // (renderFrame is pure, side effects concentrated here)
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
      process.stdout.write(ansi.hideCursor + frame)
    }
    // Cursor: position inside input box when editing; hide during permission/menu mode
    if (state.permission || state.question || state.picker || state.wizard?.step === "provider") {
      process.stdout.write(ansi.hideCursor)
    } else {
      process.stdout.write(`${"\x1b"}[${cursorRow};${cursorCol}H${ansi.showCursor}`)
    }
  }

  process.stdout.on("resize", render)

  // ---------------------------------------------------------- Submit

  async function submit() {
    const text = state.input.join("").trim()
    if (!text) return
    state.input = []
    state.cursor = 0
    state.history.push(text)
    state.historyIndex = -1
    state.scroll = 0

    // Slash commands: handled locally, don't enter agent loop
    if (text.startsWith("/")) {
      if (state.processing) {
        // While processing: read-only commands (switch/view/help) execute directly;
        // side-effect commands (clear/new/reindex/extract) are queued
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

    // While processing: queue for later, don't execute immediately
    if (state.processing) {
      state.queue.push({ text })
      pushLabel(`❯ You: (queued #${state.queue.length})`, ansi.bold + C.user)
      pushLine(text, C.dim)
      render()
      return
    }

    await turn(text)
  }

  // Interaction primitives: permission approval + Q&A input, implemented in interaction.mjs
  const { askPermission, askQuestion } = createInteraction({
    agent, state, pushLine, pushLabel, render, summarize,
  })

  // Clipboard image paste: implemented in clipboard.mjs
  const pasteClipboardImage = () => pasteClipboardImageImpl({ agent, state, pushLine, render })

  // Agent loop: implemented in agent-turn.mjs
  const turnCtx = {
    agent, state, pushLine, pushLabel, render, scheduleRender, ensureAssistantLabel,
    askPermission, askQuestion, handleSlash: null, summarize,
    get assistantLabeled() { return assistantLabeled },
    set assistantLabeled(v) { assistantLabeled = v },
  }
  const turn = (text) => runAgentTurn(turnCtx, text)

  // ---------------------------------------------------------- Slash Commands

  // Config helpers: implemented in config-helpers.mjs
  const { persistRaw, syncProviderField, maskKey } = createConfigHelpers(agent)

  // Model picker + generic picker: implemented in pickers.mjs
  const { openPicker, closePicker, renderPickerLines, openModelPicker, setProviderKey } = createPickers({
    agent, state, render, ansi, C, pushLine, pushLabel, persistRaw, askQuestion, maskKey,
  })

  // First-launch config wizard: implemented in wizard.mjs, closure deps passed via ctx
  const { startWizard, renderWizard, wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems } = createWizard({
    agent, state, pushLine, pushLabel, render, persistRaw,
    openModelPicker: () => openModelPicker(),
  })

  // /distill: impl in distill-cmd.mjs, ctx-passed
  const runDistill = () => runDistillImpl({ agent, state, pushLine, render, askPermission, distillOpts })

  // Slash command dispatch + Tab completion: implemented in slash-commands.mjs, closure deps passed via ctx
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
  // handleSlash is referenced by turnCtx (circular dep: submit → turn → handleSlash), backfilled here
  turnCtx.handleSlash = handleSlash

  // ---------------------------------------------------------- Keyboard / Mouse

  // keypress is attached to filtered keyStream: mouse sequences already intercepted and stripped upstream
  const onKeypress = createKeyHandler({
    agent, state, render, closePicker, renderPickerLines,
    handleSlash, handleTab, submit, pasteClipboardImage,
    wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems,
    renderWizard, pushLine, cleanup,
  })
  keyStream.on("keypress", onKeypress)

  // ---------------------------------------------------------- Startup screen + background indexing

  showStartup({ agent, state, opts, pushLine, pushLabel, render, startWizard })
  backgroundIndex({ agent, state, render })

  // Check for updates (non-blocking, after startup screen)
  ;(async () => {
    try {
      const { readFileSync } = await import("node:fs")
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      const { checkForUpdate } = await import("../upgrade.mjs")
      const result = await checkForUpdate(pkg.version)
      if (result?.newer) {
        // Defer: if wizard is still active, just show a dim line
        if (state.wizard) {
          pushLine(`Tip: thincoder ${result.latest} is available (run /upgrade later or restart)`, C.dim)
          render()
        } else {
          openPicker({
            title: `Update available: ${result.local} → ${result.latest}`,
            entries: [
              { type: "header", text: `thincoder ${result.latest} is available (current: ${result.local})` },
              { type: "item", text: "Upgrade now", action: "upgrade" },
              { type: "item", text: "Later", action: "later" },
            ],
            onSelect: async (sel) => {
              if (sel.action === "upgrade") {
                pushLabel(`❯ Upgrade`, ansi.bold + C.tool)
                pushLine(`Upgrading to ${result.latest}...`, C.tool)
                const { exec } = await import("node:child_process")
                const cp = exec("npm install -g thincoder@latest", { windowsHide: true })
                let stdout = ""
                cp.stdout?.on("data", (d) => { stdout += d })
                cp.stderr?.on("data", (d) => { stdout += d })
                cp.on("close", (code) => {
                  if (code === 0) {
                    pushLine(`✓ Upgraded to ${result.latest}. Restart to apply.`, C.tool)
                  } else {
                    pushLine(`✗ Upgrade failed (exit ${code}). Run \`thincoder upgrade\` manually.`, C.error)
                  }
                  render()
                })
              }
            },
          })
        }
      }
    } catch { /* network error or timeout — silently skip */ }
  })()
}

function summarize(obj) {
  const s = JSON.stringify(obj)
  return s.length > 80 ? s.slice(0, 80) + "…" : s
}
