---
type: knowledge
title: TUI 子 agent 显示契约：只 relay token，不 relay 内部工具调用
tags: [tui, subagent, relay, 显示]
author: liwei
created: 2026-07-26
---

子 agent 显示设计（三行）：第一行父 agent 的 [tool] subagent 照旧，后两行滚动显示子 agent 正文/思考 token（agent.mjs 用 role/ 前缀 relay onToken/onReasoning，TUI 剥前缀进 subOutput，截尾 300 字符）。关键教训：不要把子 agent 的 onToolCall/onToolResult relay 到 TUI——每次内部 read/grep 都会往对话区刷一行并误触"子 agent 结束"分支（曾用 /^(explore|coder|plan|sub)\// 匹配），满屏刷乱。TUI onToolResult 判定子 agent 结束用 name === "subagent" 精确匹配（最终报告经父 agent 的 subagent 工具结果回来）。有回归测试：runAgent 子 agent 内部工具调用不 relay 到父回调。
