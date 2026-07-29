import { ansi, C } from "./ansi.mjs"
import { readClipboardText, insertPastedText } from "./clipboard.mjs"

/** Keyboard event dispatch: permission confirm / question / picker / wizard / edit / scroll / history / paste.
 *  Extracted from index.mjs.
 *  ctx: { agent, state, render, renderPickerLines, closePicker,
 *         handleSlash, handleTab, submit, pasteClipboardImage,
 *         wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems,
 *         renderWizard, pushLine, cleanup } */
export function createKeyHandler(ctx) {
  const { agent, state, render, closePicker, renderPickerLines, handleSlash, handleTab, submit, pasteClipboardImage, wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems, renderWizard, pushLine, cleanup } = ctx

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

    // Ctrl+I: interrupt current generation and inject a message (time-travel inject)
    if (key.ctrl && !key.alt && key.name === "i") {
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
          pushLine(`  [inject] ${msg}`, C.warn)
          state.controller.abort({ interrupt: true, message: msg })
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

    // generic list picker: ↑↓ move, Enter confirm, Esc cancel
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
        state.picker = null // close picker first, avoid picker still being present during onSelect render
        // onSelect is async (e.g. removing a provider writes file), catch errors so they aren't swallowed
        Promise.resolve(handler?.(selected)).catch((err) => {
          pushLine(`[error] ${err.message}`, C.error)
        }).finally(() => render())
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
        } else if (key.name === "return" && items.length) {
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
    if (key.name === "return") {
      submit().catch((e) => pushLine(`[error] ${e.message}`, C.error))
      return
    }

    // Ctrl+V: paste clipboard text into the active text target
    if (key.ctrl && !key.alt && key.name === "v") {
      ;(async () => {
        const text = await readClipboardText()
        if (text) {
          insertPastedText(state, text)
          render()
        }
      })()
      return
    }

    // Ctrl+Alt+V (Windows) / Alt+V: paste clipboard image
    const isPasteImage = key.name === "v" && key.alt
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
