import {
  DESC,
  truncate,
  readBodyText,
  stripTags,
  htmlToText
} from "./shared.mjs";
import { join } from "node:path";

export const websearchTool = {
  name: "websearch",
  description: DESC("websearch"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  readonly: true,
  async execute(args, ctx) {
    const limit = args.limit ?? 8
    const url = `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`
    let html
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      html = await readBodyText(response)
    } catch (error) {
      throw new Error(`websearch request failed: ${error.cause?.code ?? error.message}`)
    }

    // 结果块 <li class="b_algo">：<h2><a href>标题</a></h2> + <p>摘要</p>
    const blocks = html.split('<li class="b_algo"').slice(1)
    const results = []
    for (const block of blocks) {
      const link = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!link) continue
      const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      results.push({
        href: link[1],
        title: stripTags(link[2]),
        snippet: snippet ? stripTags(snippet[1]) : "",
      })
      if (results.length >= limit) break
    }
    if (results.length === 0) return "(no results)"
    return truncate(
      results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}\n   ${r.snippet}`).join("\n\n"),
    )
  },
}


// ---------------------------------------------------------------- ls

export const fetchTool = {
  name: "fetch",
  description: DESC("fetch"),
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http/https URL" },
    },
    required: ["url"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (!/^https?:\/\//.test(args.url)) throw new Error("url must start with http:// or https://")
    let response
    try {
      response = await fetch(args.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        redirect: "follow",
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new Error(`fetch failed: ${error.cause?.code ?? error.message}`)
    }
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`)

    const contentType = response.headers.get("content-type") ?? ""
    const body = await readBodyText(response)
    if (!contentType.includes("text/html")) return truncate(body)
    return truncate(htmlToText(body))
  },
}
