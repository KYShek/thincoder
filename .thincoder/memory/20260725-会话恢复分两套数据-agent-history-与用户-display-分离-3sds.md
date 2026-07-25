---
type: decision
title: 会话恢复分两套数据：agent history 与用户 display 分离
tags: [session, 会话恢复, TUI, 架构决策]
author: liwei
created: 2026-07-25
---

thincoder 会话持久化（src/session.mjs）刻意分开两种恢复需求：1) agent 恢复用 history（压缩过、transient 过滤）——要模型上下文连续，可牺牲保真；2) 用户恢复用 display（TUI state.lines 渲染行 {text,color} 原样快照，上限 5000 行）——要所见即所得。教训：复用 history 重建显示必然失真——压缩摘要是毁灭性的（原文被替换），工具结果/task 留痕/思考链也都不在 history 里。saveSession(agent, display) 第二参数传 state.lines；恢复时 display 优先原样回放，旧存档无 display 才退化为 history 重建。TUI 恢复路径无离线测试，改动后需人工冒烟。
