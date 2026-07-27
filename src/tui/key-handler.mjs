import { ansi, C } from "./ansi.mjs"

/** 键盘事件分发：权限确认 / 问答 / picker / wizard / 编辑 / 翻页 / 历史 / 粘贴。
 *  从 index.mjs 抽出。
 *  ctx: { agent, state, render, renderPickerLines, closePicker,
 *         handleSlash, handleTab, submit, pasteClipboardImage,
 *         wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems,
 *         renderWizard, pushLine, cleanup } */
export function createKeyHandler(ctx) {
  const { agent, state, render, closePicker, renderPickerLines, handleSlash, handleTab, submit, pasteClipboardImage, wizardChooseProvider, wizardSubmitText, cancelWizard, wizardProviderItems, renderWizard, pushLine, cleanup } = ctx

  return function onKeypress(str, key = {}) {
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
  }
}
