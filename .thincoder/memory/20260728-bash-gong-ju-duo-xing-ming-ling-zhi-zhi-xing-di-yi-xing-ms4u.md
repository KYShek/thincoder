---
type: pattern
title: Bash 工具多行命令只执行第一行
tags: [bash, windows, cmd, git, 环境陷阱]
author: unknown
created: 2026-07-28
---
在 thincoder 项目环境（Windows，bash 工具走 cmd.exe）中，包含换行的多行 shell 命令只有第一行会被执行，后续行静默丢弃且整体仍返回 exit 0——极易造成"git add 执行了但 git commit 没执行"这类假成功。教训：复合命令必须写成单行，用 `&&` 连接（如 `git add X && git commit -m "..."`），或拆成多次工具调用。执行后务必用 git status / git log 验证结果，不要相信 exit code。
