/**
 * provider/sse.mjs — SSE stream reader
 * Extracted from core.mjs. Parses Server-Sent Events for LLM chat responses.
 */
export async function readSSE(response, { onToken, onReasoning, rules, signal, firedPatterns: sharedFired }) {
  // Early intercept: non-SSE responses — either error bodies (HTTP >= 400) or
  // valid single-chunk JSON completions (some APIs return JSON despite stream:true).
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("event-stream")) {
    const body = await response.text().catch(() => "")
    if (response.status >= 400) {
      let errorMsg = ""
      try {
        const parsed = JSON.parse(body)
        errorMsg = parsed?.error?.message
          || parsed?.base_resp?.status_msg
          || parsed?.detail
          || parsed?.message
          || parsed?.msg
          || (typeof parsed.error === "string" ? parsed.error : "")
      } catch { /* not JSON */ }
      if (!errorMsg) errorMsg = body.slice(0, 500)
      throw new Error(`API error: HTTP ${response.status} — ${errorMsg}`)
    }
    // HTTP < 400 non-SSE: might be a valid single-chunk JSON response (e.g. proxy
    // stripped SSE framing). Try to parse as a chat.completion.chunk.
    try {
      const parsed = JSON.parse(body)
      const choice = parsed.choices?.[0]
      if (choice) {
        const result = { content: "", reasoning: "", toolCalls: [], usage: parsed.usage ?? null, finishReason: null }
        const delta = choice.delta ?? {}
        result.content = delta.content ?? ""
        result.reasoning = delta.reasoning_content ?? ""
        result.finishReason = choice.finish_reason ?? null
        for (const tc of delta.tool_calls ?? []) {
          const slot = (result.toolCalls[tc.index ?? result.toolCalls.length] ??= { id: "", name: "", arguments: "" })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name && !slot.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
        }
        if (result.content) onToken?.(result.content)
        if (result.reasoning) onReasoning?.(result.reasoning)
        return result
      }
    } catch { /* not parseable JSON */ }
    // Not an error response but not a valid chunk either — unexpected
    throw new Error(`API error: HTTP ${response.status} — unexpected non-SSE response: ${body.slice(0, 200)}`)
  }

  const result = { content: "", reasoning: "", toolCalls: [], usage: null, finishReason: null }
  const decoder = new TextDecoder()
  let buffer = ""
  let hasChoices = false
  const firedPatterns = sharedFired ?? new Set()

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
      if (signal?.aborted) {
        const e = new DOMException("The operation was aborted", "AbortError")
        e.reason = signal.reason
        throw e
      }
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()
      processLines(lines)

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
    if (e.name === "AbortError" && signal?.reason?.interrupt) {
      result.interrupted = true
      result.interruptMessage = signal.reason.message
      return result
    }
    throw e
  }

  if (!hasChoices) {
    // Stream started as SSE but no choices were parsed — unusual. Include status for debugging.
    const raw = buffer.trim()
    let errorMsg = ""
    try {
      const parsed = raw ? JSON.parse(raw) : null
      errorMsg = parsed?.error?.message
        || parsed?.base_resp?.status_msg
        || parsed?.detail
        || parsed?.message
        || parsed?.msg
        || (typeof parsed.error === "string" ? parsed.error : "")
    } catch { /* not JSON */ }
    if (!errorMsg) errorMsg = `SSE stream contained no choices (HTTP ${response.status})`
    throw new Error(`API error: ${errorMsg}`)
  }

  return result
}
