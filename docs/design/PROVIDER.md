# Provider 层设计（thincoder/src/provider/）

> 状态：2026-08 回补。LLM 调用层：OpenAI 兼容协议为主 + Anthropic/Gemini 原生 transport，SSE 流式、重试/退避、TPM/RPM 闸门、截断续写、流规则、发送前载荷净化。
> 规格表（MODEL_SPECS）是能力中枢：上下文窗口、maxOutput、thinking API、reasoningEcho、tempRange、partialMode/prefixMode 等全部模型差异在此声明（见 `src/config.mjs`）。

## 1. 模块地图

| 文件 | 职责 |
|---|---|
| `index.mjs` | re-export：`chat` / `listModels` / `estimateText` 等 |
| `core.mjs` | chat 入口（transport 分派）、requestWithRetry、载荷净化（stripImages/normalizeToolPairing）、流规则编译、Kimi 401 平台提示 |
| `sse.mjs` | readSSE：OpenAI 格式 SSE 解析、增量 tool_calls 拼装、流规则触发、中断 |
| `rate.mjs` | TPM/RPM 滑动窗口闸门、token 估算、重试常量 |
| `anthropic.mjs` | Claude 原生 transport（/v1/messages + 事件流） |
| `google.mjs` | Gemini 原生 transport（generateContent streamGenerateContent + 事件流） |

## 2. chat() 流程（core.mjs）

```
chat(provider, { messages, tools, onToken, onReasoning, onWait, signal, streamRules, firedPatterns })
  1. format === "anthropic" → anthropicChat（跳过本流程）
     format === "google"   → geminiChat
  2. spec = specForModel(provider.model)
  3. body 组装：model / messages（含 reasoning_effort、thinking 参数按 spec.thinkApi 注入）/
     tools（OpenAI schema）/ temperature 按 spec.tempRange 钳位 / max_tokens 按 spec.maxOutput
  4. estimateRequestTokens(body) → rateGate（TPM/RPM 预算内睡眠等待）
  5. requestWithRetry → readSSE 流式解析
  6. 结果后处理：
     - finishReason === "length" && spec.partialMode → 截断续写（同一次响应内，content 续写；见 §5）
     - finishReason === "length" && spec.prefixMode → /beta prefix 续写（DeepSeek，附上次 usage 累计）
     - 非视觉模型发送前 stripImagesForTextModel（防 image_url 会话毒化）
     - 发送前 normalizeToolPairing（tool 消息重排/孤儿清理/缺失结果占位）
  7. 返回 { content, reasoning, toolCalls, usage, finishReason, _warnings?, interrupted? }
```

**transport 分派**：`TRANSPORTS` 表（anthropic/google/openai）——`provider.format` 决定协议；openai 是默认（body 组装在 core 内联）。

## 3. 重试与错误（requestWithRetry）

- **最多 3 次重试**（`MAX_RETRIES`）；429 尊重 `Retry-After` 头，无头则 15s/30s/60s 退避（`RATE_LIMIT_BACKOFF_MS`）；5xx/408/409/425 指数退避（2^n s）。
- **不重试**（`isNonRetryableError`）：401/403 认证、400 级非 429、429 但 body 含余额/配额特征（中文"余额不足/充值"、`insufficient_quota`、GLM 1113/1114 等）。
- **Kimi 401 平台提示**（IK5VGJ）：`sk-kimi-` 前缀 key 或 `api.kimi.com` 端点遇 401 → 错误消息追加"Moonshot vs Kimi For Coding 双平台 key 不通用"说明。
- 全部重试耗尽：按 lastStatus 分类报错（Rate limit not resolved / Server error persisted / Request failed / Network error）。
- 请求超时 600s（`FETCH_TIMEOUT_MS`），AbortError 透传（用户 Ctrl+I 取消）。

## 4. SSE 流式（sse.mjs readSSE）

- TextDecoder 分块解码，`\n\n` 分帧；`data: [DONE]` 结束。
- delta 累加：`content` / `reasoning_content`（thinking 流，转发 onReasoning）/ `tool_calls`（按 index 增量拼装 id/name/arguments）。
- **usage 帧**：`choices: []` 的 data 帧捕获 `usage`（prompt_tokens/completion_tokens/prompt_cache_hit/miss_tokens）→ 供状态栏展示与压缩实测基线（见 CONTEXT-COMPACTION.md D3）。
- **中断**：signal abort → 抛 AbortError；上层（agent.mjs）区分"用户中断注入"（`signal.reason.interrupt`）与普通取消。
- **流规则**（streamRules，`compileStreamRules` 编译）：SSE 过程中对已生成文本做正则匹配——action `abort` 立即中断并标记 `ruleTriggered`（agent 循环注入规则消息后重试）；`warn` 不中断，收集 `_warnings` 在回合后注入提醒；`repeat: "once"` 用 firedPatterns 跨调用去重（每次用户消息重置）。

## 5. 截断续写（两协议，按 spec 声明）

| 协议 | spec 字段 | 机制 | 适用 |
|---|---|---|---|
| **prefix** | `prefixMode: true` | finishReason=length → `/beta` 端点续写（`betaBaseURL`），请求体附 `prefix: true` + 上次 usage（DeepSeek 前缀计费）；reasoningEcho=required 时回传 reasoning_content | DeepSeek 系列 |
| **partial** | `partialMode: true` | 同一次响应内直接续写：`MAX_CONTINUATIONS=3` 次追加请求（不回传全文，只发新问题）；usage 跨续写累计 | Kimi / Qwen / MiniMax |

两者都会注入提醒（"[System reminder: output token limit reached…]"）让模型知道输出被截断过；GLM 的 `reasoningEcho: "optional"` 表示历史 reasoning 默认清除（clear_thinking）。

## 6. TPM/RPM 闸门（rate.mjs）

- provider 配置 `tpm`/`rpm` 后启用：**发送前**记账（60s 滑动窗口，`estimateRequestTokens` 估算），超预算 `sleep` 到窗口腾出空间（onWait 通知 UI "TPM throttle wait ~Ns"）；未配置则闸门关闭（429 退避仍生效）。
- `recordRate(provider, estimated, usage)` 在响应后以**实测 usage** 修正记账。
- 单请求估算已超预算时不卡死（放行，交给重试层）。
- 窗口按 `baseURL`（去 /beta 后缀）键控——同一端点共享预算；`_rateHooks` 可注入（测试用假时钟）。

## 7. 发送前载荷净化（纵深防御）

- **`stripImagesForTextModel(messages, spec)`**：非视觉模型发送前把残留 `image_url` 替换为文本占位符——防"视觉模型会话切到文本 provider 恢复"的存量毒化；历史本身不改，切回视觉模型图片即恢复。
- **`normalizeToolPairing(messages)`**：严格 provider（DeepSeek）要求 tool 消息紧跟其 owner assistant——历史可能合法地违反（并行多模态注入、压缩切割、中断残留）→ 发送前：tool 消息重排到 owner 之后、孤儿 tool 丢弃、缺失结果合成 `[Tool result missing: …]` 占位。与 CLI/VS Code 压缩的配对保护（见 CONTEXT-COMPACTION.md D5）同语义，一个管源头一个管兜底。

## 8. 原生 transport

- **Anthropic**（`format: "anthropic"`）：POST `/v1/messages`，`anthropic-version: 2023-06-01`；system 消息抽离；tool 用 `tool_use`/`tool_result` block；事件流解析（content_block_start/delta/stop + message_delta 的 usage）。
- **Gemini**（`format: "google"`）：`generateContent` + `streamGenerateContent?alt=sse`；role 映射（assistant→model）；图像 data URL → inlineData（base64 + mime）；usage 从 `usageMetadata` 取（`noUsageStream` 模型无流式 usage）。

## 9. 关键设计决策

| 决策 | 理由 |
|---|---|
| 规格表驱动一切能力差异 | 新模型只加一行 spec，transport/续写/thinking 全自动适配；未知模型保守 128K + 警告（IK5VGJ） |
| 实测 usage 优先于估算 | 估算对 CJK 低估 3-4x；实测值锚定压缩判定（D3）与 TPM 记账 |
| 发送前净化而非改历史 | 历史是模型上下文真相，净化只作用于线上载荷，可逆 |
| 429 双通道（闸门+退避） | 闸门防患于未然（省一次失败往返），退避兜底（未配置预算也安全） |
| 流规则 abort 后重试 | 内容合规是硬需求——中断注入提醒让模型自行修正，比事后清洗更可靠 |
