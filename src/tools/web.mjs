import { DESC, truncate, stripTags, htmlToText } from "./shared.mjs";
import { URL } from "node:url";
import { resolveWebProxy, proxyFetch } from "../proxy.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const FETCH_TIMEOUT = 15_000

// ── Web search (direct fetch, no proxy needed for Bing) ──

function extractBing(html) {
  const results = []
  const blocks = html.split('<li class="b_algo"').slice(1)
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    results.push({ href: link[1], title: stripTags(link[2]), snippet: snippet ? stripTags(snippet[1]) : "" })
  }
  return results
}

function bingUrl(query, page) {
  let u = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&setmkt=en-US`
  if (page > 1) u += `&first=${(page - 1) * 10 + 1}`
  return u
}

const ENGINES = [{ name: "bing", label: "Bing", url: bingUrl, extract: extractBing, ua: UA }]
const ENGINE_NAMES = ENGINES.map(e => e.name)

async function fetchEngine(engine, query, page) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    const response = await globalThis.fetch(engine.url(query, page), {
      headers: { "User-Agent": engine.ua, "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8" },
      signal: ctrl.signal,
    })
    if (!response.ok) return null
    const html = await response.text()
    const results = engine.extract(html)
    return { engine: engine.name, results }
  } catch { return null }
  finally { clearTimeout(timer) }
}

export const websearchTool = {
  name: "websearch",
  description: DESC("websearch"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 8, max 20)" },
      engine: { type: "string", enum: ENGINE_NAMES, description: "Specific engine — \"bing\" (Bing). Omit to search all engines concurrently." },
      page: { type: "number", description: "Page number for pagination (1-based, default 1). Only used when engine is specified." },
    },
    required: ["query"],
  },
  readonly: true,
  async execute(args, ctx) {
    const limit = Math.min(args.limit ?? 8, 20)
    const page = Math.max(1, args.page ?? 1)
    if (args.engine) {
      const engine = ENGINES.find(e => e.name === args.engine)
      if (!engine) return `Unknown engine '${args.engine}'. Available: ${ENGINE_NAMES.join(", ")}`
      const fetched = await fetchEngine(engine, args.query, page)
      if (!fetched || fetched.results.length === 0) return `(no results from ${engine.label})`
      return truncate(fetched.results.slice(0, limit).map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}\n   ${r.snippet}`).join("\n\n"))
    }
    const promises = ENGINES.map(e => fetchEngine(e, args.query, 1))
    const fetched = (await Promise.all(promises)).filter(Boolean)
    if (fetched.length === 0) return "(no results — all search engines failed)"
    const merged = [], indexes = fetched.map(() => 0)
    let done = false
    while (!done && merged.length < limit) {
      done = true
      for (let i = 0; i < fetched.length; i++) {
        if (indexes[i] < fetched[i].results.length) {
          merged.push({ ...fetched[i].results[indexes[i]], _engine: fetched[i].engine })
          indexes[i]++; done = false
          if (merged.length >= limit) break
        }
      }
    }
    return truncate(merged.slice(0, limit).map((r, i) => `${i + 1}. [${r._engine}] ${r.title}\n   ${r.href}\n   ${r.snippet}`).join("\n\n"))
  },
}

// ── Fetch tool (with proxy support) ──────

function isPrivateUrl(urlStr) {
  let u; try { u = new URL(urlStr) } catch { return true }
  const host = u.hostname.toLowerCase()
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost")) return false
  if (host === "127.0.0.1" || host.startsWith("127.")) return false
  if (host === "169.254.169.254" || host === "metadata.google.internal") return true
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; if (a === 10||a === 172&&b>=16&&b<=31||a === 192&&b===168||a === 169&&b===254||a===0) return true }
  if (host === "::1" || host === "fe80::1" || host.startsWith("fc") || host.startsWith("fd")) return true
  return false
}

export const fetchTool = {
  name: "fetch",
  description: DESC("fetch"),
  parameters: { type: "object", properties: { url: { type: "string", description: "http/https URL" } }, required: ["url"] },
  readonly: true,
  async execute(args, ctx) {
    if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://")
    if (isPrivateUrl(args.url)) throw new Error("fetch blocked: internal/private/metadata addresses are not allowed")
    try {
      const proxyUri = resolveWebProxy(ctx)
      const response = await proxyFetch(args.url, { headers: { "User-Agent": UA } }, proxyUri)
      if (!response.ok) {
        if ([301, 302, 307, 308].includes(response.status)) {
          const loc = response.headers?.location || response.headers?.Location
          if (loc) {
            const r2 = await proxyFetch(loc, { headers: { "User-Agent": UA } }, proxyUri)
            if (!r2.ok) throw new Error(`fetch failed: HTTP ${r2.status}`)
            const ct2 = r2.headers?.["content-type"] || r2.headers?.["Content-Type"] || ""
            const b2 = await r2.text()
            return ct2.includes("text/html") ? truncate(htmlToText(b2)) : truncate(b2)
          }
        }
        throw new Error(`fetch failed: HTTP ${response.status}`)
      }
      const ct = response.headers?.["content-type"] || response.headers?.["Content-Type"] || ""
      const body = await response.text()
      return ct.includes("text/html") ? truncate(htmlToText(body)) : truncate(body)
    } catch (e) { throw new Error(`fetch failed: ${e.cause?.code ?? e.message}`) }
  },
}
