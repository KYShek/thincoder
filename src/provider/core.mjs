/**
 * provider/core.mjs — LLM call core
 * chat / listModels / createProvider / requestWithRetry / readSSE
 */

import { specForModel } from "../config.mjs"
import { proxyFetch } from "../proxy.mjs"
import {
  RETRYABLE_STATUS, MAX_RETRIES, MAX_CONTINUATIONS,
  RATE_LIMIT_BACKOFF_MS, _rateHooks,
  estimateRequestTokens, rateGate, recordRate,
} from "./rate.mjs"

const FETCH_TIMEOUT_MS = 600_000

/** Create a validated provider config object from raw config */
export function createProvider(config) {
  if (!config?.baseURL) throw new Error("provider config: baseURL is required — configure providers in ~/.thincoder/config.json")
  if (!config?.apiKey) throw new Error("provider config: apiKey is required — set THINCODER_API_KEY env or configure in ~/.thincoder/config.json")
  if (!config?.model) throw new Error("provider config: model is required — configure in ~/.thincoder/config.json")
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
    format: config.format,
    chatPath: config.chatPath,
    proxy: config.proxy,
    proxyUri: config.proxyUri,
  }
}

/** Send a streaming chat completion request with automatic continuation on truncation */
export async function chat(provider, { messages, tools, onToken, onReasoning, onWait, signal, streamRules }) {
  // Format dispatch: delegate to non-OpenAI transports
  if (provider.format === "anthropic") {
    const { chat: anthropicChat } = await import("./anthropic.mjs")
    const { normalizeTools } = await import("./anthropic.mjs")
    const result = await anthropicChat(provider, {
      messages,
      tools: tools?.length ? normalizeTools(tools) : null,
      onToken, onReasoning, signal,
    })
    return result
  }
  if (provider.format === "google") {
    const { chat: geminiChat } = await import("./google.mjs")
    const { normalizeTools } = await import("./google.mjs")
    const result = await geminiChat(provider, {
      messages,
      tools: tools?.length ? normalizeTools(tools) : null,
      onToken, onReasoning, signal,
    })
    return result
  }

  const spec = specForModel(provider.model)
  messages = stripImagesForTextModel(messages, spec)
  // Compile string-pattern rules to RegExp at call time
  const rules = compileStreamRules(streamRules)
  const body = {
    model: provider.model,
    messages,
    stream: true,
  }
  // Skip usage stream for models that don't support it (GLM, MiniMax, Gemini)
  if (!spec.noUsageStream) body.stream_options = { include_usage: true }
  if (provider.maxTokens) body.max_tokens = provider.maxTokens
  if (provider.temperature != null) {
    let t = provider.temperature
    if (spec.tempRange) {
      t = Math.min(spec.tempRange[1], Math.max(spec.tempRange[0], t))
      t = Math.round(t * 100) / 100
    }
    body.temperature = t
  }
  if (provider.thinking) body.thinking = provider.thinking
  if (provider.reasoningEffort && provider.format !== "anthropic" && provider.format !== "google") {
    if (spec.reasoningEffortEnum && !spec.reasoningEffortEnum.includes(provider.reasoningEffort)) {
      throw new Error(
        `reasoning_effort "${provider.reasoningEffort}" not supported by model "${provider.model}"; ` +
        `valid values: ${spec.reasoningEffortEnum.join(", ")}`
      )
    }
    body.reasoning_effort = provider.reasoningEffort
  }
  if (tools?.length) body.tools = tools

  const estimated = estimateRequestTokens(body)
  await rateGate(provider, estimated, onWait, signal)

  const response = await requestWithRetry(provider, body, signal, onWait)
  const result = await readSSE(response, { onToken, onReasoning, rules, signal })
  recordRate(provider, estimated, result.usage)

  // Stream rule triggered or user interrupted mid-generation — return partial result
  if (result.ruleTriggered) return result
  if (result.interrupted) return result

  // Retry on transient server overload (DeepSeek: insufficient_system_resource)
  const MAX_OVERLOAD_RETRIES = 1
  for (let r = 0; result.finishReason === "insufficient_system_resource" && r <= MAX_OVERLOAD_RETRIES; r++) {
    if (r > 0) {
      onWait?.({ phase: "overloaded", seconds: 3 })
      await _rateHooks.sleep(3000)
    }
    const retryResponse = await requestWithRetry(provider, body, signal, onWait)
    const retryResult = await readSSE(retryResponse, { onToken, onReasoning })
    recordRate(provider, estimated, retryResult.usage)
    if (retryResult.finishReason !== "insufficient_system_resource") {
      // Merge any partial content from the failed attempt (streaming already showed it)
      result.content += retryResult.content
      result.reasoning += retryResult.reasoning ?? ""
      for (const tc of retryResult.toolCalls ?? []) {
        const idx = tc.index ?? result.toolCalls.length
        const s = (result.toolCalls[idx] ??= { id: "", name: "", arguments: "" })
        if (tc.id) s.id = tc.id
        s.name += tc.name ?? ""
        s.arguments += tc.arguments ?? ""
      }
      result.finishReason = retryResult.finishReason
      if (retryResult.usage) result.usage = retryResult.usage
      break
    }
    // Retry exhausted — keep the partial result with insufficient_system_resource finish_reason
  }

  if (!spec.partialMode && !spec.prefixMode) return result
  for (let n = 0; result.finishReason === "length" && result.content && n < MAX_CONTINUATIONS; n++) {
    const continued = await chat(spec.prefixMode ? { ...provider, baseURL: betaBaseURL(provider.baseURL) } : provider, {
      messages: [
        ...messages,
        spec.partialMode
          ? {
              role: "assistant",
              content: result.content,
              partial: true,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            }
          : { role: "assistant", content: result.content, prefix: true, ...(result.reasoning ? { reasoning_content: result.reasoning } : {}) },
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
      const idx = tc.index ?? result.toolCalls.length
      const s = (result.toolCalls[idx] ??= { id: "", name: "", arguments: "" })
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
        prompt_cache_hit_tokens: sum("prompt_cache_hit_tokens"),
        prompt_cache_miss_tokens: sum("prompt_cache_miss_tokens"),
      }
    }
  }
  return result
}

/**
 * Replace image parts with text placeholders when the model has no vision support.
 * History may contain image_url parts (e.g. a session resumed after switching from a vision model
 * to a text-only one); text-only APIs like DeepSeek reject the ENTIRE request with 400 if any
 * message contains an image part, which bricks the conversation. Sanitize at send time — history
 * itself is left untouched, so switching back to a vision model restores the images.
 */
export function stripImagesForTextModel(messages, spec) {
  if (spec.multimodal) return messages
  let changed = false
  const out = messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((p) => p?.type === "image_url")) return m
    changed = true
    return {
      ...m,
      content: m.content.map((p) =>
        p?.type === "image_url" ? { type: "text", text: "[image omitted — this model does not support image input]" } : p),
    }
  })
  return changed ? out : messages
}

/** List available model IDs from the provider's /models endpoint */
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

async function requestWithRetry(provider, body, signal, onWait) {
  let lastError
  let lastStatus = 0
  let lastWas429 = false
  let rateLimitHits = 0
  const totalAttempts = MAX_RETRIES + 1
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && !lastWas429) await _rateHooks.sleep(2 ** (attempt - 1) * 1000)
    lastWas429 = false

    let response
    try {
      const url = `${provider.baseURL}${provider.chatPath ?? "/chat/completions"}`
      const opts = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
      response = provider.proxyUri
        ? await proxyFetch(url, opts, provider.proxyUri)
        : await fetch(url, opts)
    } catch (error) {
      if (error.name === "AbortError") throw error
      lastError = error
      continue
    }

    if (response.ok) return response

    const text = await response.text().catch(() => "")
    const message = `LLM API error ${response.status}: ${text}`
    lastStatus = response.status
    if (isNonRetryableError(response.status, text)) throw new Error(message)
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
  // All retries exhausted — build a descriptive error
  const verb = lastWas429 ? "Rate limit not resolved"
    : lastStatus >= 500 ? "Server error persisted"
    : lastStatus > 0 ? "Request failed"
    : "Network error"
  throw new Error(`${verb} after ${totalAttempts} attempts${lastStatus ? ` (${lastStatus})` : ""}: ${lastError?.message ?? "unknown"}`)
}

/**
 * Detect errors that should NOT be retried — quota, billing, auth, invalid params.
 * Different providers use wildly different error formats. Check body text for known patterns.
 */
function isNonRetryableError(status, text) {
  // Auth errors: never retry
  if (status === 401 || status === 403) return true
  // 400-level non-429: usually invalid params
  if (status >= 400 && status < 500 && status !== 429 && !RETRYABLE_STATUS.has(status)) return true
  // For 429, check if it's actually a billing/quota error (not rate limit)
  if (status === 429) {
    const lower = text.toLowerCase()
    // Chinese providers often return 429 for billing issues
    if (lower.includes("余额不足") || lower.includes("余额") || lower.includes("充值")) return true
    if (lower.includes("insufficient") && (lower.includes("balance") || lower.includes("quota") || lower.includes("credit"))) return true
    if (lower.includes("quota") && (lower.includes("exceeded") || lower.includes("insufficient"))) return true
    // Standard OpenAI billing error (error.type === "insufficient_quota" or similar)
    try {
      const j = JSON.parse(text)
      const errType = j?.error?.type || ""
      if (typeof errType === "string" && (errType.includes("quota") || errType.includes("billing") || errType.includes("insufficient") || errType.includes("balance"))) return true
      const errCode = j?.error?.code || ""
      if (typeof errCode === "string" && (errCode === "1113" || errCode === "1114")) return true // GLM billing codes
    } catch {}
  }
  return false
}

export async function readSSE(response, { onToken, onReasoning, rules, signal }) {
  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""
  let hasChoices = false
  // Track patterns already fired this turn for repeat: "once" gating
  const firedPatterns = new Set()

  const processLines = (lines) => {
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue

      let json
      try { json = JSON.parse(data) } catch { continue }

      if (json.usage) result.usage = json.usage
      const choice = json.choices?.[0]
      if (!choice) continue
      hasChoices = true
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
      for (const tc of delta.tool_calls ?? []) {
        const slot = (result.toolCalls[tc.index] ??= { id: "", name: "", arguments: "" })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name && !slot.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.arguments += tc.function.arguments
      }
    }
  }

  if (!response.body) throw new Error("No stream response body")
  try {
    for await (const chunk of response.body) {
      // Active signal check: Ctrl+I abort should halt stream immediately, not wait for
      // the underlying fetch stream to propagate the abort (delayed on Windows).
      if (signal?.aborted) {
        const e = new DOMException("The operation was aborted", "AbortError")
        e.reason = signal.reason
        throw e
      }
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()
      processLines(lines)

      // Time-traveling stream rules: check accumulated content against patterns.
      // Only triggers on text content (not during tool_call generation) to avoid
      // interrupting structured tool use.
      // action "abort": halt the stream immediately and retry with the rule injected.
      // action "warn":  let the stream finish, then inject the warning after the turn (non-interrupting).
      // repeat "once":  skip if this rule's pattern has already fired in the current turn.
      if (rules?.length && result.content && !result.toolCalls.length) {
        for (const rule of rules) {
          if (rule.repeat === "once" && firedPatterns.has(rule.pattern)) continue
          if (rule._regex.test(result.content)) {
            if (rule.repeat === "once") firedPatterns.add(rule.pattern)
            if (rule.action === "abort") {
              result.ruleTriggered = true
              result.ruleMessage = rule.message
              result.ruleName = rule.name
              return result
            }
            // warn: accumulate deduplicated by pattern, let the stream complete
            const existing = result._warnings ??= []
            if (!existing.some(w => w.pattern === rule.pattern)) {
              existing.push({ name: rule.name, pattern: rule.pattern, message: rule.message })
            }
          }
        }
      }
    }
    buffer += decoder.decode()
    processLines(buffer.split("\n"))
  } catch (e) {
    // User interrupt (Ctrl+I): controller.abort({ interrupt: true, message: "…" }).
    // The interrupted signal.reason carries the user's message; return partial content
    // so the agent loop can inject it as a user message and retry.
    if (e.name === "AbortError" && signal?.reason?.interrupt) {
      result.interrupted = true
      result.interruptMessage = signal.reason.message
      return result
    }
    throw e
  }

  // If no SSE choices were found, the response is likely a JSON error
  if (!hasChoices) {
    const contentType = response.headers.get("content-type") || ""
    let errorMsg = ""
    try {
      const raw = buffer.trim() || ""
      if (raw) {
        const parsed = JSON.parse(raw)
        errorMsg = parsed?.error?.message
          || parsed?.base_resp?.status_msg
          || parsed?.detail
          || parsed?.message
          || parsed?.msg
          || (typeof parsed.error === "string" ? parsed.error : "")
      }
    } catch { /* not JSON */ }
    if (!errorMsg && !contentType.includes("event-stream")) {
      errorMsg = `Response is not SSE (Content-Type: ${contentType || "unknown"})`
    }
    if (errorMsg) {
      throw new Error(`API error: ${errorMsg}`)
    }
  }

  return result
}

function betaBaseURL(baseURL) {
  // DeepSeek prefix continuation uses /beta endpoint; only handle /v1 suffix, append /beta when /v1 is missing
  if (/\/v1$/.test(baseURL)) return baseURL.replace(/\/v1$/, "/beta")
  return baseURL.endsWith("/") ? baseURL + "beta" : baseURL + "/beta"
}

/**
 * Compile stream rules from config format (string patterns) to executable RegExp objects.
 * Rules format: { pattern: "regex source", message: "reminder text", action: "abort"|"warn" }
 */
export function compileStreamRules(rules) {
  if (!rules?.length) return null
  return rules.map((r) => {
    try {
      return { ...r, _regex: new RegExp(r.pattern, r.flags ?? "") }
    } catch {
      // Invalid regex — skip silently so one bad rule doesn't break the whole pipeline
      return null
    }
  }).filter(Boolean)
}
