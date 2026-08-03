import { ansi, C } from "./ansi.mjs"
import { readClipboardText, insertPastedText } from "./clipboard.mjs"
import { computeLayout } from "./layout.mjs"

/** Perform search on state.lines, update state.search.matches and clamp index */
function performSearch(state) {
  if (!state.search) return
  const query = state.search.query.toLowerCase()
  state.search.matches = []
  // Clear old highlights
  state.lines.forEach(l => delete l._searchMatches)

  if (!query) { state.search.index = 0; return }

  state.lines.forEach((line, lineIndex) => {
    const text = (line.text || "").toLowerCase()
    let charIndex = text.indexOf(query)
    if (charIndex !== -1) {
      line._searchMatches = []
    }
    while (charIndex !== -1) {
      state.search.matches.push({ lineIndex, charIndex })
      line._searchMatches.push(charIndex)
      charIndex = text.indexOf(query, charIndex + 1)
    }
  })

  if (state.search.matches.length === 0) {
    state.search.index = 0
  } else {
    state.search.index = Math.min(state.search.index, state.search.matches.length - 1)
  }
}

/** Estimate scroll position to make a line visible (simplified) */
function scrollToMatch(state, lineIndex) {
  if (lineIndex == null) return
  // Rough estimate: each state.line takes 1-2 rendered lines
  let estimatedLine = 0
  for (let i = 0; i < lineIndex && i < state.lines.length; i++) {
    estimatedLine += Math.max(1, Math.ceil((state.lines[i].text?.length || 0) / 80))
  }
  const rows = process.stdout.rows || 24
  const visibleH = Math.max(5, rows - 10) // reserve space for header, input, status, etc.
  // scroll is number of lines hidden above viewport
  // We want estimatedLine to be near the bottom of the viewport
  state.scroll = Math.max(0, state.lines.length - estimatedLine - visibleH + 3)
}

/** Keyboard event dispatch: permission confirm / question / picker / wizard / edit / scroll / history / paste.
 *  Extracted from index.mjs.
 *  ctx: { agent, state, render, renderPickerLines, popPicker,
 *         handleSlash, handleTab, submit, pasteClipboardImage,
 *         wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems,
 *         renderWizard, pushLine, cleanup, showPicker } */
export function createKeyHandler(ctx) {
  const { agent, state, render, popPicker, renderPickerLines, handleSlash, handleTab, submit, pasteClipboardImage, wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems, renderWizard, pushLine, cleanup, showPicker } = ctx

  return function onKeypress(str, key = {}) {
    // permission confirm state: y approve / n deny / a approve + turn ON AUTO (no further prompts)
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
        // leave trail: record approval/denial in conversation (continue prompt has its own output, don't duplicate)
        if (!isContinue) {
          pushLine(`  [${approved ? "approved" : "denied"}] ${name}`, approved ? C.dim : C.error)
        }
        resolve(approved)
        render()
      }
      return
    }

    // question tool callback: free text / option selection
    if (state.question) {
      const q = state.question
      if (q.options.length > 0) {
        // options mode: ↑↓ select, Enter confirm, Esc cancel
        if (key.name === "escape") {
          q.resolve("")
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
        // free text: type answer, Enter submit, Esc cancel
        if (key.name === "escape") {
          q.resolve("")
          state.question = null
          state.status = "Processing..."
          render()
        } else if (key.name === "return") {
          if (q._pasting) return // block Enter while paste is in flight
          const answer = (q.answer ?? "").trim()
          q.resolve(answer || "")
          state.question = null
          state.status = "Processing..."
          pushLine(`  → ${answer || "(empty)"}`, C.tool)
          render()
        } else if (key.name === "backspace") {
          q.answer = (q.answer ?? "").slice(0, -1)
          render()
        } else if (key.ctrl && !key.alt && key.name === "v") {
          // Ctrl+V paste: read clipboard text (fires when the terminal passes Ctrl+V through
          // as a key event; bracketed-paste terminals are handled upstream in the stdin handler)
          if (q._pasting) return
          q._pasting = true
          readClipboardText().then((text) => {
            q._pasting = false
            if (text) {
              insertPastedText(state, text)
              render()
            }
          }).catch((e) => {
            q._pasting = false
            console.error(`[tui] clipboard paste failed: ${e.message}`)
          })
        } else if (str && !key.ctrl && !key.meta) {
          q.answer = (q.answer ?? "") + str
          render()
        }
      }
      return
    }

    // Search mode: Ctrl+F to enter, Ctrl+N/Ctrl+P (or Ctrl+G/Ctrl+R) navigate, Esc exit
  if (key.ctrl && key.name === "f" && !state.permission && !state.question) {
    if (!state.search) {
      state.search = { query: "", matches: [], index: 0 }
    }
    render()
    return
  }

  if (state.search) {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      state.search = null
      render()
      return
    }
    // Navigation requires Ctrl — bare n/p are query characters (regression fix: bare n/p
    // used to hijack typing, making it impossible to type those letters into the query)
    if ((key.ctrl && key.name === "n") || (key.ctrl && key.name === "g")) {
      // Next match
      if (state.search.matches.length > 0) {
        state.search.index = (state.search.index + 1) % state.search.matches.length
        scrollToMatch(state, state.search.matches[state.search.index].lineIndex)
      }
      render()
      return
    }
    if ((key.ctrl && key.name === "p") || (key.ctrl && key.name === "r")) {
      // Previous match
      if (state.search.matches.length > 0) {
        state.search.index = (state.search.index - 1 + state.search.matches.length) % state.search.matches.length
        scrollToMatch(state, state.search.matches[state.search.index].lineIndex)
      }
      render()
      return
    }
    if (key.name === "return") {
      // Exit search mode but keep highlighting until next Ctrl+F
      state.search = null
      render()
      return
    }
    if (key.name === "backspace") {
      if (state.search.query.length > 0) {
        state.search.query = state.search.query.slice(0, -1)
        performSearch(state)
        render()
      }
      return
    }
    // Regular character input
    if (str && str.length === 1 && !key.ctrl && !key.alt && !key.meta) {
      state.search.query += str
      performSearch(state)
      if (state.search.matches.length > 0) {
        scrollToMatch(state, state.search.matches[state.search.index].lineIndex)
      }
      render()
      return
    }
    // Swallow every other key (arrows/Tab/Delete/…) — without this they fall through
    // to normal input handling and edit the HIDDEN state.input instead of the search box
    return
  }

  if (key.ctrl && key.name === "c") {
      // picker 打开时 Ctrl+C = 取消当前 picker（等同 Esc），不杀进程
      if (state.picker) {
        popPicker(null)
        return
      }
      if (state.processing && state.controller) {
        state.controller.abort()
        pushLine("[Aborting…]", C.warn)
        render()
        return
      }
      // 防误触：空闲态第一次 Ctrl+C 仅提示并武装，窗口内再按才真正退出
      if (!state.exitArmed) {
        state.exitArmed = true
        if (ctx.exitArmTimer) clearTimeout(ctx.exitArmTimer)
        ctx.exitArmTimer = setTimeout(() => { state.exitArmed = false }, ctx.exitArmDelay ?? 3000)
        ctx.exitArmTimer.unref?.()
        pushLine("[exit] Press Ctrl+C again within 3s to exit", C.warn)
        render()
        return
      }
      if (ctx.exitArmTimer) clearTimeout(ctx.exitArmTimer)
      cleanup()
      // 延迟退出可注入（测试传大值并清理定时器，避免定时器在 mock 恢复后调到真 process.exit）
      ctx.exitTimer = setTimeout(() => process.exit(0), ctx.exitDelay ?? 100)
      ctx.exitTimer.unref?.()
    }

    // F1: 显示快捷键帮助
    if (key.name === "f1" && !state.picker && !state.permission && !state.question) {
      showPicker("Keyboard Shortcuts", [
        { type: "item", text: "Ctrl+C — Cancel/Abort; idle: press twice to exit" },
        { type: "item", text: "Ctrl+I — Interrupt and inject message" },
        { type: "item", text: "Ctrl+F — Search conversation history" },
        { type: "item", text: "Shift+Enter / Ctrl+J — Insert newline (multiline input)" },
        { type: "item", text: "Alt+V — Paste clipboard image" },
        { type: "item", text: "Ctrl+U — Clear input line" },
        { type: "item", text: "Esc — Cancel current input/picker" },
        { type: "item", text: "↑/↓ — Navigate input history" },
        { type: "item", text: "PgUp/PgDn — Scroll conversation" },
        { type: "item", text: "Enter — Send message or confirm selection" },
        { type: "item", text: "F1 — Show this help" },
      ])
      return
    }

    // Ctrl+I (or Tab during processing): interrupt and inject a message
    if ((key.ctrl && !key.alt && key.name === "i") || (key.name === "tab" && state.processing && !state.interruptPrompt)) {
      if (state.processing && state.controller && !state.interruptPrompt) {
        state.interruptPrompt = { text: "" }
        render()
      }
      return
    }

    // Interrupt prompt mode: type message, Enter to inject, Esc to cancel
    if (state.interruptPrompt) {
      if (key.name === "escape") {
        state.interruptPrompt = null
        render()
      } else if (key.name === "return") {
        const msg = (state.interruptPrompt.text ?? "").trim()
        state.interruptPrompt = null
        if (msg) {
          // Guard: if the turn already finished while the user was typing, the controller
          // may have been replaced or already aborted — don't abort a live turn by mistake.
          if (state.processing && state.controller && !state.controller.signal.aborted) {
            pushLine(`  [inject] ${msg}`, C.warn)
            state.controller.abort({ interrupt: true, message: msg })
          } else {
            pushLine(`  [inject — turn ended, message queued] ${msg}`, C.dim)
          }
          render()
        }
      } else if (key.name === "backspace") {
        state.interruptPrompt.text = state.interruptPrompt.text.slice(0, -1)
        render()
      } else if (str && !key.ctrl && !key.meta) {
        state.interruptPrompt.text += str.replace(/[\r\n]+/g, "")
        render()
      }
      return
    }

    // generic list picker: ↑↓/PgUp/PgDn/Home/End 导航，输入即过滤，Enter 选中，Esc 取消
    if (state.picker) {
      const p = state.picker
      const items = p.filteredItems ?? p.entries.filter((e) => e.type === "item")
      // 可视窗高度：直接取 layout 算出的实际 picker 面板高（含小终端 pickerFinalH 压缩），减标题行。
      // 单一数据源，避免与 layout.mjs 公式漂移
      const winH = Math.max(1, (computeLayout(state, { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }).panels.picker?.h ?? p.lines.length + 1) - 1)
      const applyFilter = (f) => {
        p.filter = f
        p.index = 0
        p.scroll = 0
        renderPickerLines()
      }
      if (key.name === "escape") {
        popPicker(null)
      } else if (key.name === "up" && items.length) {
        p.index = (p.index - 1 + items.length) % items.length
        renderPickerLines()
      } else if (key.name === "down" && items.length) {
        p.index = (p.index + 1) % items.length
        renderPickerLines()
      } else if (key.name === "pageup" && items.length) {
        p.index = Math.max(0, p.index - winH)
        renderPickerLines()
      } else if (key.name === "pagedown" && items.length) {
        p.index = Math.min(items.length - 1, p.index + winH)
        renderPickerLines()
      } else if (key.name === "home" && items.length) {
        p.index = 0
        renderPickerLines()
      } else if (key.name === "end" && items.length) {
        p.index = items.length - 1
        renderPickerLines()
      } else if (key.name === "backspace") {
        if (p.filter) applyFilter(p.filter.slice(0, -1))
      } else if ((key.name === "return" || key.name === "enter" || str === "\r") && items.length) {
        popPicker(items[p.index]) // 选中即关闭
      } else if (str && !key.ctrl && !key.meta) {
        // 输入即过滤；粘贴的多行文本先去换行（与输入框清洗口径一致），仍含控制字符则整段丢弃
        const text = str.replace(/[\r\n]+/g, "")
        if (text && !/[\x00-\x1f\x7f]/.test(text)) applyFilter(p.filter + text)
      }
      return
    }

    // initial config wizard: menu step ↑↓/Enter/Esc; text step Enter submit, Esc cancel, edit keys fall through to normal input
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
        } else if ((key.name === "return" || key.name === "enter" || str === "\r") && items.length) {
          wizardChooseProvider(items[w.index])
        }
        return
      }
      if (key.name === "return") {
        wizardSubmitText()
        return
      }
      // text steps: block scroll/history, remaining edit keys fall through to normal input logic below
      if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") return
    }

    // page scroll
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
      // during processing, allow input (queued), but block arrow-key history and Tab completion
      if (key.name === "tab" || key.name === "up" || key.name === "down") return
      // Ctrl+D: remove last item from queue
      if (key.ctrl && key.name === "d") {
        if (state.queue.length > 0) {
          state.queue.pop()
          render()
        }
        return
      }
      // remaining printable characters go into input box normally
    }

    // Tab: slash-command completion (cycle candidates); other input ignored (\t would blow up input box, never inserted directly)
    if (key.name === "tab") {
      handleTab()
      return
    }

    // Ctrl+U: clear entire input box
    if ((key.name === "u" && key.ctrl) || str === "\x15") {
      state.input = []
      state.cursor = 0
      render()
      return
    }

    // input history
    if (key.name === "up") {
      if (state.history.length) {
        // Draft protection: entering history navigation with unsent input stashes it,
        // so navigating back down past the newest entry restores what was being typed.
        if (state.historyIndex === -1 && state.input.length > 0) {
          state._draft = [...state.input]
        }
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
          // Restore the stashed draft instead of wiping back to blank
          state.input = state._draft ? [...state._draft] : []
          state._draft = null
        } else {
          state.input = [...state.history[state.historyIndex]]
        }
        state.cursor = state.input.length
        render()
      }
      return
    }

    // cursor movement
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

    // editing
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
    if (key.name === "return" || key.name === "enter" || str === "\r") {
      // Multiline newline — three entry points (docs/design/TUI-INPUT-BOX.md §1.5):
      //  1. Alt+Enter: readline parses \x1b\r as meta+return (all terminals)
      //  2. Shift+Enter: keyboard-enhanced terminals send \x1b[13;2u / \x1b[27;2;13~,
      //     translateShiftEnter maps them to \x1b\r → also meta+return
      //  3. Ctrl+J: sends \n (0x0A), readline parses as name:"enter" — the universal
      //     fallback: \n and \r are distinct bytes in EVERY terminal, no protocol needed
      //     (legacy conhost users: Shift+Enter is a bare \r there, physically
      //     indistinguishable from Enter — Ctrl+J is their newline key)
      if ((key.name === "return" && key.meta) || key.name === "enter") {
        state.input.splice(state.cursor, 0, "\n")
        state.cursor++
        render()
      } else {
        submit().catch((e) => pushLine(`[error] ${e.message}`, C.error))
      }
      return
    }

    // Ctrl+V: paste clipboard text into the active text target.
    // Exclude meta (ESC-prefix) so Ctrl+Alt+V — which readline reports as ctrl+meta —
    // falls through to the image-paste branch below instead of being eaten here.
    if (key.ctrl && !key.alt && !key.meta && key.name === "v") {
      ;(async () => {
        const text = await readClipboardText()
        if (text) {
          insertPastedText(state, text)
          render()
        }
      })()
      return
    }

    // Alt+V / Ctrl+Alt+V: paste clipboard image.
    // NOTE: readline reports ESC-prefixed combos as key.meta, NOT key.alt (probe-verified:
    // \x1b + char → { meta: true, alt: false }). Checking key.alt alone is a dead branch —
    // the key fell through to the printable handler which ignores meta keys, so image paste
    // silently did nothing. Accept meta (and alt, for terminals that set it); the text-paste
    // branch above excludes meta so Ctrl+Alt+V reaches here.
    const isPasteImage = key.name === "v" && (key.alt || key.meta)
    if (isPasteImage) {
      pasteClipboardImage(agent).catch((e) => pushLine(`[error] ${e.message}`, C.error))
      return
    }

    // printable characters / paste (str may contain multiple chars at once); Tab always converted to two spaces (\t has variable display width, would blow up input box)
    // \r\n may leak through in Windows raw mode and scramble the display
    if (str && !key.ctrl && !key.meta) {
      const chars = [...str.replace(/[\r\n]+/g, "").replace(/\t/g, "  ")]
      state.input.splice(state.cursor, 0, ...chars)
      state.cursor += chars.length
      render()
    }
  }
}
