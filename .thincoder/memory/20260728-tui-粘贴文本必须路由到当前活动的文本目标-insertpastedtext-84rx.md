---
type: knowledge
title: TUI 粘贴文本必须路由到当前活动的文本目标（insertPastedText）
tags: [tui, paste, clipboard, bracketed-paste, question, input-routing]
author: liwei
created: 2026-07-28
---

thincoder TUI 开启了 bracketed paste（ansi.bracketedPasteOn，index.mjs 启动时写入 \x1b[?2004h）。现代终端（Windows Terminal 等）粘贴时把文本包在 \x1b[200~...\x1b[201~ 里，由 index.mjs 的 stdin data 处理器整段拦截，不经过 keypress 事件。

关键教训：TUI 里有多个文本缓冲区——主输入框 state.input、自由文本提问 state.question.answer（/model 加 provider 输 API key 走的就是 askQuestion 自由文本提问）。粘贴文本若一律塞进 state.input，在提问激活时不可见、不会被提交，提问关闭后还会残留污染主输入框（2026-07 用户报告的"/model 输 API key 粘贴不进去"根因）。

约定：所有粘贴入口统一走 clipboard.mjs 的 insertPastedText(state, rawText)：
- 自由文本提问激活 → 追加到 q.answer（单行，去掉换行）
- 选项式提问激活 → 丢弃（无文本框）
- 否则 → 插入 state.input 光标处（保留 \n 多行，\t → 两空格）

两条粘贴投递路径都要覆盖：bracketed paste（终端侧注入，Windows Terminal 默认）和 Ctrl+V 键事件（key-handler.mjs 里 readClipboardText 读系统剪贴板，conhost raw mode 场景）。 wizard 文本步骤读 state.input，走默认路径即可。
