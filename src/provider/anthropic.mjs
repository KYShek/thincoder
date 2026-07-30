/**
 * provider/anthropic.mjs — Anthropic Messages API (Claude)
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Docs: https://docs.anthropic.com/en/api/messages
 */

import { specForModel } from "../config.mjs"
import { proxyFetch } from "../proxy.mjs"

const ANTHROPIC_VERSION = "2023-06-01"

/** Convert OpenAI-format tools to Anthropic format */
export function normalizeTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }))
}

/** Build and send an Anthropic chat request. Returns the same shape as core.mjs chat. */
export async function chat(provider, { messages, tools, onToken, onReasoning, signal }) {
  // Extract system message(s) — Anthropic uses top-level `system` field
  const systemMessages = []
  const chatMessages = []
  for (const m of messages) {
    if (m.role === "system") {
      systemMessages.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    } else {
      chatMessages.push(m)
    }
  }

  const spec = specForModel(provider.model)
  const body = {
    model: provider.model,
    messages: chatMessages,
    stream: true,
    max_tokens: provider.maxTokens || (spec.maxOutput || 8192),
  }
  if (systemMessages.length > 0) body.system = systemMessages.join("\n\n")
  if (tools?.length) body.tools = tools
  if (provider.temperature != null) {
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }

  const FETCH_TIMEOUT_MS = 600_000
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": provider.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  }

  // Active signal check
  if (signal?.aborted) throw Object.assign(new DOMException("Aborted", "AbortError"), { reason: signal.reason })

  const response = await proxyFetch(`${provider.baseURL}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, provider.proxyUri)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Anthropic API error ${response.status}: ${text}`)
  }

  const result = await parseAnthropicStream(response, { onToken, onReasoning, signal })

  // Convert Anthropic usage format to OpenAI-compatible
  const usage = result.usage
  if (usage) {
    return {
      content: result.content,
      reasoning: result.reasoning,
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        prompt_cache_hit_tokens: usage.cache_read_input_tokens ?? 0,
        prompt_cache_miss_tokens: usage.cache_creation_input_tokens ?? 0,
      },
      toolCalls: result.toolCalls,
    }
  }

  return { content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls }
}

/**
 * Parse Anthropic SSE stream.
 * Events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
 */
async function parseAnthropicStream(response, { onToken, onReasoning, signal }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null }
  const decoder = new TextDecoder()
  let buffer = ""
  const toolBlocks = new Map()

  const processEvent = (eventType, data) => {
    if (!data) return
    let json
    try { json = JSON.parse(data) } catch { return }

    switch (eventType) {
      case "message_start":
        if (json.message?.usage) result.usage = json.message.usage
        break
      case "content_block_start": {
        const block = json.content_block
        if (block?.type === "tool_use") {
          toolBlocks.set(json.index, { id: block.id, name: block.name, arguments: "" })
        }
        break
      }
      case "content_block_delta": {
        const delta = json.delta
        if (delta?.type === "text_delta" && delta.text) {
          result.content += delta.text
          onToken?.(delta.text)
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          result.reasoning += delta.thinking
          onReasoning?.(delta.thinking)
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const block = toolBlocks.get(json.index)
          if (block) block.arguments += delta.partial_json
        }
        break
      }
      case "message_delta":
        if (json.usage) result.usage = json.usage
        break
      case "message_stop":
        for (const [, block] of toolBlocks) {
          result.toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments })
        }
        break
    }
  }

  if (!response.body) throw new Error("No stream response body")
  let currentEvent = ""
  let currentData = ""

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
      if (line.startsWith("event: ")) {
        if (currentEvent) processEvent(currentEvent, currentData)
        currentEvent = line.slice(7).trim()
        currentData = ""
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6).trim()
      } else if (line === "") {
        if (currentEvent) processEvent(currentEvent, currentData)
        currentEvent = ""
        currentData = ""
      }
    }
  }
  // Flush remaining
  buffer += decoder.decode()
  for (const line of buffer.split("\n")) {
    if (line.startsWith("event: ")) {
      if (currentEvent) processEvent(currentEvent, currentData)
      currentEvent = line.slice(7)
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6)
    }
  }
  if (currentEvent) processEvent(currentEvent, currentData)

  return result
}
