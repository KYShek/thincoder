---
type: decision
title: multi-provider 配置结构
tags: [architecture, config, multi-provider]
author: liwei
created: 2026-07-24
---

配置结构改为 multi-provider：providers[] + activeProvider。每个 provider 有 name/baseURL/model/apiKey。运行时 agent.provider 是当前激活的 runtime provider 快照（{baseURL, apiKey, model}），agent.providers 存完整列表。切换时从列表取覆盖 agent.provider，同时自动持久化 activeProvider。环境变量 THINCODER_ACTIVE_PROVIDER 可覆盖激活项。session 存 activeProvider 名称而非 model 字符串。
