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

/**
 * 创建 provider。config: { baseURL, apiKey, model, maxTokens?, temperature?, thinking?, reasoningEffort? }
 * thinking: { type: "enabled"|"disabled" }  思维模式开关
 * reasoningEffort: "low"|"high"|"max"       推理强度（DeepSeek/Kimi/GLM 通用）
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
  }
}

/**
 * 流式对话。
 * messages: OpenAI 格式数组; tools: OpenAI tools schema（可选）
 * onToken(text): 正文流式回调; onReasoning(text): 思考流回调（DeepSeek-R1 类模型）
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
export async function chat(provider, { messages, tools, onToken, onReasoning, signal }) {
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

  const response = await requestWithRetry(provider, body, signal)
  const result = await readSSE(response, { onToken, onReasoning })

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
    result.usage = {
      prompt_tokens: (result.usage?.prompt_tokens??0) + (continued.usage.prompt_tokens??0),
      completion_tokens: (result.usage?.completion_tokens??0) + (continued.usage.completion_tokens??0),
      total_tokens: (result.usage?.total_tokens??0) + (continued.usage.total_tokens??0),
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

/** 带重试的请求：网络错误与 429/5xx 指数退避（1s/2s/4s），其余 4xx 直接抛 */
async function requestWithRetry(provider, body, signal) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 1000)

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
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = new Error(message)
      continue
    }
    throw new Error(message)
  }
  throw lastError
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
      // tool_calls 按 index 分槽累积，name/arguments 都是分片到达的
      for (const tc of delta.tool_calls ?? []) {
        const slot = (result.toolCalls[tc.index] ??= { id: "", name: "", arguments: "" })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** DeepSeek Prefix Completion 只在 /beta 端点开放：.../v1 → .../beta */
function betaBaseURL(baseURL) {
  return baseURL.replace(/\/v1$/, "/beta")
}
