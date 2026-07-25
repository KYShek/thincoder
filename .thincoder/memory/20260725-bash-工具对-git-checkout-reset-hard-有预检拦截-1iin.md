---
type: rule
title: bash 工具对 git checkout -- / reset --hard 有预检拦截
tags: [git, bash, 安全, 拦截, 教训]
author: liwei
created: 2026-07-25
---

tools.mjs 的 bash execute 入口处加了安全预检：遇到 `git checkout --`、`git checkout .`、`git reset --hard` 时，先跑 `git status --porcelain`——有未提交改动就拒绝执行并提示先 commit/stash。起因：edit 工具间歇性故障时，批处理脚本破坏文件后盲开 `git checkout --` 把今天全部工作丢了。防范原理：销毁性操作之前必须验证工作树干净，不依赖 agent 的自觉判断。
