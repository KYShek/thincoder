---
type: pattern
title: 安全机制必须对模型可见才有效：checkpoint 事故复盘
tags: [checkpoint, 安全, 护栏, bash, git]
author: liwei
created: 2026-07-26
---

2026-07 事故：模型 git checkout 弄丢未提交代码，有 checkpoint 快照却没用上。根因三层：1) checkpoint 只接了 TUI 自动快照 + 用户 /rewind 命令，没暴露成工具，模型物理上无法调用；2) SYSTEM_PROMPT 零提及，模型不知道快照存在；3) bash 销毁性 git 护栏正则只锚行首的 checkout --/reset --hard，checkout .（无 --）、restore、clean -f、&& 链式全部绕过。教训：给人用的安全机制 ≠ 给模型用的；防线要成对——护栏（事前拦截）+ 恢复工具（事后自救），两者都要在模型的工具列表和知识里。修复：checkpoint 工具（list/create/rewind）+ isDestructiveGitSegment 分段检测。
