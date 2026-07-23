/**
 * provider.mjs — LLM 调用层
 * 原生 fetch 直连 OpenAI 兼容协议，SSE 流式，零依赖。
 * 覆盖：OpenAI / DeepSeek / Moonshot / Ollama / 一切 OpenAI 兼容端点。
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES = 3

/**
 * 创建 provider。config: { baseURL, apiKey, model, maxTokens?, temperature? }
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
  }
}

/**
 * 流式对话。
 * messages: OpenAI 格式数组; tools: OpenAI tools schema（可选）
 * onToken(text): 正文流式回调; onReasoning(text): 思考流回调（DeepSeek-R1 类模型）
 * signal: AbortSignal（可选）
 * 返回 { content, reasoning, toolCalls: [{id, name, arguments}], usage, finishReason }
 * 注意：toolCalls[i].arguments 是 JSON 字符串，调用方负责 parse
 */
export async function chat(provider, { messages, tools, onToken, onReasoning, signal }) {
  const body = {
    model: provider.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (provider.maxTokens) body.max_tokens = provider.maxTokens
  if (provider.temperature != null) body.temperature = provider.temperature
  if (tools?.length) body.tools = tools

  const response = await requestWithRetry(provider, body, signal)
  return readSSE(response, { onToken, onReasoning })
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
      response = await fetch(`${provider.baseURL}/chat/completions`, {
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

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() // 最后半行留到下一轮

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
  return result
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
