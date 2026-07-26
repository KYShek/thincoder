/**
 * provider.mjs — LLM 调用层
 * 原生 fetch 直连 OpenAI 兼容协议，SSE 流式，零依赖。
 * 覆盖：OpenAI / DeepSeek / Moonshot / Ollama / 一切 OpenAI 兼容端点。
 * 模型私有能力（Kimi/Qwen Partial Mode、DeepSeek Prefix Completion）由 config.mjs 的规格表声明，这里只按能力开关分支。
 */

import { specForModel } from "./config.mjs"

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const MAX_CONTINUATIONS = 3 // Partial Mode 截断续写上限（防异常的无限 length 循环）
// 429 的专项退避：RPM/TPM 按 60s 窗口计（账户级独立计数器），通用退避的 1s/2s/4s 等不出窗口
const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000]

/**
 * 测试钩子：睡眠/时钟/窗口长度可替换（离线测试不能真等 60s）。
 * 生产代码不要直接调 setTimeout/sleep，统一走这里。
 */
export const _rateHooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  windowMs: 60_000,
}

// ---------------------------------------------------------------- TPM/RPM 主动节流闸门

/**
 * 滑动窗口闸门：发请求前若 窗口内已耗 + 本次估算 超预算，就睡到最早的记录滑出窗口。
 * 按 baseURL+apiKey 记账（限速是账户级）；预算来自 provider.tpm / provider.rpm，
 * 不配则闸门关闭（429 反应式退避仍然生效）。主循环/压缩摘要/子 agent/截断续写全走这里。
 */
const rateWindows = new Map() // key → { tokens: [{ts, n}], requests: [ts] }

function rateKey(provider) {
  return `${provider.baseURL}|${provider.apiKey ?? ""}`
}

/** 粗估文本 token 数（与 context.mjs 同口径：ASCII/4 + 非 ASCII/1；context 依赖本模块，不能反向 import） */
function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

/** 本次请求的 prompt 估算：messages 正文 + 思考链 + tool_calls 参数 + tools schema */
function estimateRequestTokens(body) {
  let tokens = 0
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") tokens += estimateText(m.content)
    if (typeof m.reasoning_content === "string") tokens += estimateText(m.reasoning_content)
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateText(tc.function?.name ?? "") + estimateText(tc.function?.arguments ?? "")
    }
  }
  if (body.tools) tokens += estimateText(JSON.stringify(body.tools))
  return tokens
}

/** 闸门：超预算则睡到窗口腾出空间；onWait({phase:"gate", seconds}) 供 UI 展示等待 */
async function rateGate(provider, estimated, onWait, signal) {
  // 单次请求估算已超过 TPM 预算时闸门无意义（等到天荒地老也塞不下），放行由服务端裁决
  const tpm = provider.tpm != null && estimated <= provider.tpm ? provider.tpm : null
  const rpm = provider.rpm ?? null
  if (tpm == null && rpm == null) return
  const w = rateWindows.get(rateKey(provider)) ?? { tokens: [], requests: [] }
  rateWindows.set(rateKey(provider), w)
  for (;;) {
    const now = _rateHooks.now()
    const cutoff = now - _rateHooks.windowMs
    w.tokens = w.tokens.filter((e) => e.ts > cutoff)
    w.requests = w.requests.filter((ts) => ts > cutoff)
    const usedTokens = w.tokens.reduce((s, e) => s + e.n, 0)
    const overTokens = tpm != null ? usedTokens + estimated - tpm : 0
    const overRequests = rpm != null ? w.requests.length + 1 - rpm : 0
    if (overTokens <= 0 && overRequests <= 0) break
    let waitMs = _rateHooks.windowMs
    if (overTokens > 0) {
      // tokens 按时间升序：累加最早若干条，过期量足够腾出空间时的过期时刻
      let freed = 0
      for (const e of w.tokens) {
        freed += e.n
        if (freed >= overTokens) {
          waitMs = Math.min(waitMs, e.ts + _rateHooks.windowMs - now)
          break
        }
      }
    }
    if (overRequests > 0) {
      // 等第 overRequests-1 条（升序）滑出，窗口内请求数即降回 rpm-1
      waitMs = Math.min(waitMs, w.requests[overRequests - 1] + _rateHooks.windowMs - now)
    }
    waitMs = Math.max(waitMs, 50)
    onWait?.({ phase: "gate", seconds: Math.ceil(waitMs / 1000) })
    await _rateHooks.sleep(waitMs)
    if (signal?.aborted) return
  }
}

/** 记账：响应回来后按实测 usage 记（无 usage 用发送前的估算兜底）；被拒的请求不记（服务端未处理） */
function recordRate(provider, estimated, usage) {
  if (provider.tpm == null && provider.rpm == null) return
  const w = rateWindows.get(rateKey(provider)) ?? { tokens: [], requests: [] }
  rateWindows.set(rateKey(provider), w)
  const now = _rateHooks.now()
  w.requests.push(now)
  // TPM 按输入+输出总量计（Moonshot 口径）
  w.tokens.push({ ts: now, n: usage ? (usage.prompt_tokens ?? estimated) + (usage.completion_tokens ?? 0) : estimated })
}

/**
 * 创建 provider。config: { baseURL, apiKey, model, maxTokens?, temperature?, thinking?, reasoningEffort?, tpm?, rpm? }
 * thinking: { type: "enabled"|"disabled" }  思维模式开关
 * reasoningEffort: "low"|"high"|"max"       推理强度（DeepSeek/Kimi/GLM 通用）
 * tpm / rpm: 主动节流预算（tokens/分钟、请求数/分钟，按账户限速等级自配），不配则闸门关闭
 */
export function createProvider(config) {
  if (!config?.baseURL) throw new Error("provider config: baseURL is required")
  if (!config?.apiKey) throw new Error("provider config: apiKey is required (config file or THINCODER_API_KEY env)")
  if (!config?.model) throw new Error("provider config: model is required")
  return {
    baseURL: config.baseURL.replace(/\/+$/, ""),
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    tpm: config.tpm,
    rpm: config.rpm,
  }
}

/**
 * 流式对话。
 * messages: OpenAI 格式数组; tools: OpenAI tools schema（可选）
 * onToken(text): 正文流式回调; onReasoning(text): 思考流回调（DeepSeek-R1 类模型）
 * onWait({phase, seconds}): 节流等待回调（phase: "gate"=主动节流 / "retry"=429 退避）
 * signal: AbortSignal（可选）
 * 返回 { content, reasoning, toolCalls: [{id, name, arguments}], usage, finishReason }
 * 注意：toolCalls[i].arguments 是 JSON 字符串，调用方负责 parse
 *
 * 截断续写（按规格表能力门控，未声明的模型原样返回截断结果）：
 * finish_reason=length 且已有正文时，把已输出内容作为前缀 assistant 消息回传，
 * 模型接着续写而非丢弃重跑。思考阶段被截断（content 为空）时无前缀可续，直接返回。
 * - partialMode（Kimi / Qwen）：assistant 消息带 partial:true；K3 思考续写需回传 reasoning_content
 * - prefixMode（DeepSeek）：assistant 消息带 prefix:true，且须走 /beta 端点；
 *   思考模式不支持前缀续写，已产出 reasoning 时放弃续写
 */
export async function chat(provider, { messages, tools, onToken, onReasoning, onWait, signal }) {
  const spec = specForModel(provider.model)
  const body = {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (provider.maxTokens) body.max_tokens = provider.maxTokens
  if (provider.temperature != null) {
    // 按规格表裁剪 temperature：GLM [0,1] 限两位小数，DeepSeek ≤2，未声明则不裁剪
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }
  if (provider.thinking) body.thinking = provider.thinking
  if (provider.reasoningEffort) {
    // 按规格表校验 reasoning_effort 枚举：不在枚举内则报错，不映射、不猜测
    if (spec.reasoningEffortEnum && !spec.reasoningEffortEnum.includes(provider.reasoningEffort)) {
      throw new Error(
        `reasoning_effort "${provider.reasoningEffort}" not supported by model "${provider.model}"; ` +
        `valid values: ${spec.reasoningEffortEnum.join(", ")}`
      )
    }
    body.reasoning_effort = provider.reasoningEffort
  }
  if (tools?.length) body.tools = tools

  // TPM/RPM 主动节流：超预算先在本地睡到窗口腾出空间，不打 429 碰运气
  const estimated = estimateRequestTokens(body)
  await rateGate(provider, estimated, onWait, signal)

  const response = await requestWithRetry(provider, body, signal, onWait)
  const result = await readSSE(response, { onToken, onReasoning })
  recordRate(provider, estimated, result.usage)

  // 截断续写：仅规格表声明续写协议的模型（其他端点不认识 partial/prefix 字段，可能 400）
  if (!spec.partialMode && !spec.prefixMode) return result
  // DeepSeek prefix 续写不支持思考模式，已产出 reasoning 时无前缀协议可用
  if (spec.prefixMode && !spec.partialMode && result.reasoning) return result
  for (let n = 0; result.finishReason === "length" && result.content && n < MAX_CONTINUATIONS; n++) {
    const continued = await chat(spec.prefixMode ? { ...provider, baseURL: betaBaseURL(provider.baseURL) } : provider, {
      messages: [
        ...messages,
        spec.partialMode
          ? {
              role: "assistant",
              content: result.content,
              partial: true,
              // K3 思考模式续写必须回传 reasoning_content
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            }
          : { role: "assistant", content: result.content, prefix: true },
      ],
      tools,
      onToken,
      onReasoning,
      onWait,
      signal,
    })
    result.content += continued.content
    result.reasoning += continued.reasoning ?? ""
    for (const tc of continued.toolCalls ?? []) {
      if (tc.index == null) { result.toolCalls = continued.toolCalls; break }
      const s = result.toolCalls[tc.index] ??= { id: "", name: "", arguments: "" }
      if (tc.id) s.id = tc.id
      s.name += tc.name ?? ""
      s.arguments += tc.arguments ?? ""
    }
    result.finishReason = continued.finishReason
    if (continued.usage) {
      const sum = (k) => (result.usage?.[k] ?? 0) + (continued.usage[k] ?? 0)
      result.usage = {
        prompt_tokens: sum("prompt_tokens"),
        completion_tokens: sum("completion_tokens"),
        total_tokens: sum("total_tokens"),
        // 缓存命中/未命中也要累计（DeepSeek 计费与状态栏展示依赖这两个字段）
        prompt_cache_hit_tokens: sum("prompt_cache_hit_tokens"),
        prompt_cache_miss_tokens: sum("prompt_cache_miss_tokens"),
      }
    }
  }
  return result
}

/**
 * 拉取端点可用模型列表（GET /v1/models）。
 * 返回模型 id 数组；端点不支持时抛错。
 */
export async function listModels(provider, { signal } = {}) {
  const response = await fetch(`${provider.baseURL}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`GET /models failed ${response.status}: ${text}`)
  }
  const data = await response.json()
  return (data.data ?? []).map((m) => m.id).filter(Boolean).sort()
}

/**
 * 带重试的请求：网络错误与 5xx 指数退避（1s/2s/4s）；429 专项处理——
 * 有 Retry-After 以它为准，没有按 15s/30s/60s 退避（RPM/TPM 是 60s 窗口，秒级退避等不出去）。
 * 配额/余额错误（如 exceeded_current_quota_error）与限速同状态码但语义不同：重试无用，直接抛。
 */
async function requestWithRetry(provider, body, signal, onWait) {
  let lastError
  let lastWas429 = false
  let rateLimitHits = 0 // 连续 429 计数（退避档位用，与 attempt 解耦）
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && !lastWas429) await _rateHooks.sleep(2 ** (attempt - 1) * 1000)
    lastWas429 = false

    let response
    try {
      response = await fetch(`${provider.baseURL}${provider.chatPath ?? "/chat/completions"}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (error.name === "AbortError") throw error
      lastError = error // 网络层错误，可重试
      continue
    }

    if (response.ok) return response

    const text = await response.text().catch(() => "")
    const message = `LLM API error ${response.status}: ${text}`
    if (isQuotaError(text)) throw new Error(message)
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATE_LIMIT_BACKOFF_MS[Math.min(rateLimitHits++, RATE_LIMIT_BACKOFF_MS.length - 1)]
      lastError = new Error(message)
      lastWas429 = true
      if (attempt < MAX_RETRIES) {
        onWait?.({ phase: "retry", seconds: Math.ceil(waitMs / 1000) })
        await _rateHooks.sleep(waitMs)
      }
      continue
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(message)
      continue
    }
    throw new Error(message)
  }
  throw lastError
}

/** 配额/余额错误（重试无意义）：错误体 type 含 quota，如 Moonshot exceeded_current_quota_error */
function isQuotaError(text) {
  try {
    const type = JSON.parse(text)?.error?.type
    return typeof type === "string" && type.includes("quota")
  } catch {
    return false
  }
}

/** 解析 SSE 流，累积正文/思考/tool_calls */
async function readSSE(response, { onToken, onReasoning }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""

  const processLines = (lines) => {
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue

      let json
      try {
        json = JSON.parse(data)
      } catch {
        continue // 忽略坏行，流不能因为一帧坏数据断掉
      }

      if (json.usage) result.usage = json.usage
      const choice = json.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) result.finishReason = choice.finish_reason

      const delta = choice.delta ?? {}
      if (delta.reasoning_content) {
        result.reasoning += delta.reasoning_content
        onReasoning?.(delta.reasoning_content)
      }
      if (delta.content) {
        result.content += delta.content
        onToken?.(delta.content)
      }
      // tool_calls 按 index 分槽累积，arguments 是分片到达的需拼接；
      // name 个别 API（GLM 偶尔）会重发完整 name 而非增量，用 += 会拼成 "readread"——只取第一次非空值
      for (const tc of delta.tool_calls ?? []) {
        const slot = (result.toolCalls[tc.index] ??= { id: "", name: "", arguments: "" })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name && !slot.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.arguments += tc.function.arguments
      }
    }
  }

  if (!response.body) throw new Error("No stream response body")
    for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() // 最后半行留到下一轮
    processLines(lines)
  }
  // flush 解码器内部残留（流以不完整 UTF-8 序列截断时不丢尾部字节），并处理没有换行结尾的尾行
  buffer += decoder.decode()
  processLines(buffer.split("\n"))
  return result
}

/** DeepSeek Prefix Completion 只在 /beta 端点开放：.../v1 → .../beta */
function betaBaseURL(baseURL) {
  return baseURL.replace(/\/v1$/, "/beta")
}
