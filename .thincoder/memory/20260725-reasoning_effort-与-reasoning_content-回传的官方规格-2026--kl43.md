---
type: knowledge
title: reasoning_effort 与 reasoning_content 回传的官方规格(2026-07)
tags: [model-spec, provider, adapter, glm, deepseek, kimi]
author: liwei
created: 2026-07-25
---

经官方 API 文档核实的模型协议差异(非训练数据):

reasoning_effort 枚举:
- DeepSeek V4: [high, max](服务端会把 low/medium→high, xhigh→max,但用户面只认这两个)
- Kimi K3: [low, high, max],默认 max。K3 始终思考 + 始终 Preserved Thinking
- GLM-5.2: [max, xhigh, high, medium, low, minimal, none],默认 max

reasoning_content 跨轮回传:
- DeepSeek: 必须回传(缺失 400, prefix 续写要求)
- Kimi K3: 应回传(Preserved Thinking 默认开启,历史 reasoning_content 保留在上下文)
- GLM-5.2: clear_thinking 默认 true(服务端自动清除历史 reasoning_content),不必回传;若回传也不报错

temperature 范围:
- DeepSeek: ≤2, 默认1
- GLM-5.2: [0.0, 1.0] 限两位小数, 默认1.0
- Kimi: 文档未明确限制(透传即可)

来源:
- DeepSeek: api-docs.deepseek.com/zh-cn/api/create-chat-completion
- Kimi: platform.moonshot.cn/docs/api/chat (llms.txt 900-910, 1135-1148)
- GLM: docs.bigmodel.cn/api-reference/模型-api/对话补全.md (OpenAPI schema 350-413, 1231-1238)
