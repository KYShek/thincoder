/**
 * provider/sse.mjs — SSE stream reader
 * Extracted from core.mjs. Parses Server-Sent Events for LLM chat responses.
 */
export async function readSSE(response, { onToken, onReasoning, rules, signal, firedPatterns: sharedFired }) {
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
