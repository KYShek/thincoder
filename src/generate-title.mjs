/**
 * generate-title.mjs — LLM-generated session titles (CLI side)
 * Called after the first user message to auto-title the session.
 * Mirrors thincoder-vscode/src/extension/generate-title.mjs but uses the CLI provider shape.
 */

/** Generate a session title from the first user message using an LLM. Returns title string or null. */
export async function generateTitle(userContent, provider) {
  // Extract text even from multimodal content (array of parts)
  const userText = Array.isArray(userContent)
    ? userContent.find((p) => p.type === "text")?.text || ""
    : userContent
  if (typeof userText !== "string" || userText.length < 10) return null
  if (!provider?.apiKey || !provider?.baseURL || !provider?.model) return null

  try {
    const body = JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: "Generate a concise title (max 40 chars, no quotes) for this conversation. Reply ONLY with the title." },
        { role: "user", content: userText.slice(0, 200) },
      ],
      max_tokens: 30,
      stream: false,
    })
    const chatPath = provider.chatPath ?? "/chat/completions"
    const url = `${provider.baseURL.replace(/\/+$/, "")}${chatPath}`
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body,
      signal: AbortSignal.timeout(10000),
    }
    const res = provider.proxyUri
      ? await (await import("../proxy.mjs")).proxyFetch(url, opts, provider.proxyUri)
      : await fetch(url, opts)
    if (!res.ok) return null
    const data = await res.json()
    const title = data.choices?.[0]?.message?.content?.trim().slice(0, 40)
    return title || null
  } catch {
    return null
  }
}
