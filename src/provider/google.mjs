/**
 * provider/google.mjs — Google Gemini API transport
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
 * Docs: https://ai.google.dev/gemini-api/docs
 */

/** Convert OpenAI-format tools to Gemini format */
export function normalizeTools(tools) {
  if (!tools?.length) return null
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "object", properties: {} },
    })),
  }]
}

/**
 * Convert OpenAI-format messages to Gemini contents array.
 * Gemini: [{ role: "user"|"model", parts: [{ text }] }]
 * system → systemInstruction (top-level in request body)
 */
function convertMessages(messages) {
  const contents = []
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user"
    if (role === "system") continue

    const parts = []
    if (typeof m.content === "string") {
      parts.push({ text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") parts.push({ text: part.text })
        else if (part.type === "image_url") {
          const url = part.image_url?.url || ""
          const mimeMatch = url.match(/^data:([^;]+);base64,(.+)$/)
          if (mimeMatch) {
            parts.push({ inlineData: { mimeType: mimeMatch[1], data: mimeMatch[2] } })
          }
        }
      }
    }
    if (parts.length === 0) continue

    // Gemini doesn't allow consecutive same-role messages; merge
    const last = contents[contents.length - 1]
    if (last?.role === role) {
      last.parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }
  return contents
}

/** Build and send a Gemini chat request. Returns the same shape as core.mjs chat. */
export async function chat(provider, { messages, tools, onToken, onReasoning, signal }) {
  const systemMessages = messages.filter((m) => m.role === "system")
  const contents = convertMessages(messages)

  const body = {
    contents,
    generationConfig: {
      ...(provider.temperature != null ? { temperature: provider.temperature } : {}),
      ...(provider.maxTokens ? { maxOutputTokens: provider.maxTokens } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  }
  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
    }
  }
  if (tools?.length) body.tools = tools

  const FETCH_TIMEOUT_MS = 600_000
  // Gemini uses API key as query parameter
  const url = `${provider.baseURL}/models/${provider.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(provider.apiKey)}`

  if (signal?.aborted) throw Object.assign(new DOMException("Aborted", "AbortError"), { reason: signal.reason })

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Gemini API error ${response.status}: ${text}`)
  }

  const result = await parseGeminiStream(response, { onToken, onReasoning, signal })

  const usage = result.usage
  if (usage) {
    return {
      content: result.content,
      reasoning: result.reasoning,
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
      toolCalls: result.toolCalls,
    }
  }

  return { content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls }
}

/**
 * Parse Gemini SSE stream.
 * Format: data: {...}\n\n (each line is a complete JSON object)
 */
async function parseGeminiStream(response, { onToken, onReasoning, signal }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null }
  const decoder = new TextDecoder()
  let buffer = ""

  const processData = (data) => {
    let json
    try { json = JSON.parse(data) } catch { return }
    if (!json) return

    if (json.usageMetadata) {
      result.usage = {
        prompt_tokens: json.usageMetadata.promptTokenCount || 0,
        completion_tokens: json.usageMetadata.candidatesTokenCount || 0,
        total_tokens: json.usageMetadata.totalTokenCount || 0,
      }
    }

    const candidate = json.candidates?.[0]
    if (!candidate) return

    const parts = candidate.content?.parts || []
    for (const part of parts) {
      if (part.thought === true && part.text) {
        result.reasoning += part.text
        onReasoning?.(part.text)
      } else if (part.text) {
        result.content += part.text
        onToken?.(part.text)
      } else if (part.functionCall) {
        const existing = result.toolCalls.find((tc) => tc.name === part.functionCall.name)
        if (!existing) {
          result.toolCalls.push({
            id: part.functionCall.name + "_" + result.toolCalls.length,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          })
        }
      }
    }
  }

  if (!response.body) throw new Error("No stream response body")
  for await (const chunk of response.body) {
    if (signal?.aborted) {
      const e = new DOMException("Aborted", "AbortError")
      e.reason = signal.reason
      throw e
    }
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      processData(data)
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    processData(data)
  }

  return result
}
