/**
 * proxy.mjs — Shared proxy tunnel for websearch, fetch, and provider calls.
 * Zero dependencies: Node built-ins only (net, tls, http, url).
 */
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { URL } from "node:url";

const FETCH_TIMEOUT = 15_000

/**
 * Resolve proxy URI.
 * New format: { proxy: { uri: "http://host:port", web: true, model: false } }
 * Old format: { proxy: "http://host:port" } — backwards compatible, web=true model=false
 * Env vars: HTTPS_PROXY, HTTP_PROXY, ALL_PROXY
 *
 * @returns {{ uri: string|null, web: boolean, model: boolean }}
 */
export function resolveProxyConfig(ctx) {
  const cfgProxy = ctx?.agent?.config?.proxy
  if (!cfgProxy) {
    const uri = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null
    return { uri, web: !!uri, model: false }
  }
  if (typeof cfgProxy === "string") {
    // Backward compat: bare string → web only
    return { uri: cfgProxy, web: true, model: false }
  }
  return {
    uri: cfgProxy.uri || cfgProxy.url || null,
    web: cfgProxy.web !== false,
    model: cfgProxy.model === true,
  }
}

/** Convenience: resolve proxy URI for web tools (websearch/fetch) */
export function resolveWebProxy(ctx) {
  const cfg = resolveProxyConfig(ctx)
  return (cfg.uri && cfg.web) ? cfg.uri : null
}

/** Convenience: resolve proxy URI for a specific provider */
export function resolveProviderProxy(ctx, provider) {
  if (!provider?.proxy) return null
  const cfg = resolveProxyConfig(ctx)
  return cfg.uri || null
}

/**
 * HTTPS request through HTTP CONNECT proxy tunnel.
 * Returns a Response-like: { ok, status, headers: Record<string,string>, text(): Promise<string> }
 */
export function tunnelHttps(urlStr, opts, proxyUri, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr)
    const proxy = new URL(proxyUri)
    const headers = opts?.headers ?? {}
    const method = opts?.method ?? "GET"

    const sock = connect({ host: proxy.hostname, port: Number(proxy.port) || 3128 })
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("Proxy CONNECT timeout")) }, timeout)
    sock.on("connect", () => sock.write(`CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}\r\n\r\n`))

    let buf = ""
    sock.on("data", d => {
      buf += d.toString()
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const statusLine = buf.slice(0, end).split("\r\n")[0]
      buf = buf.slice(end + 4)
      if (!statusLine.includes("200")) { sock.destroy(); clearTimeout(timer); return reject(new Error(`Proxy CONNECT: ${statusLine}`)) }
      sock.removeAllListeners("data"); clearTimeout(timer)

      const tlsSock = tlsConnect({ socket: sock, servername: target.hostname, rejectUnauthorized: false, timeout })
      if (buf) tlsSock.unshift(Buffer.from(buf))
      tlsSock.on("secureConnect", () => {
        const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`]
        const allHeaders = { ...headers, Host: target.hostname }
        for (const [k, v] of Object.entries(allHeaders)) lines.push(`${k}: ${v}`)
        lines.push("Connection: close", "", "")
        tlsSock.write(lines.join("\r\n"))
        if (opts?.body) tlsSock.write(opts.body)
        readHttpResponse(tlsSock, timeout).then(resolve, reject)
      })
      tlsSock.on("error", e => { sock.destroy(); reject(e) })
    })
    sock.on("error", e => { clearTimeout(timer); reject(e) })
  })
}

async function readHttpResponse(sock, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("Response timeout")) }, timeout)
    let headerDone = false, headerBuf = "", chunks = [], bodyBytes = 0
    let contentLength = -1

    sock.on("data", d => {
      if (!headerDone) {
        headerBuf += d.toString("utf8", 0, Math.min(d.length, 65536))
        const idx = headerBuf.indexOf("\r\n\r\n")
        if (idx < 0) return
        clearTimeout(timer)
        headerDone = true

        const headerText = headerBuf.slice(0, idx)
        const statusMatch = headerText.match(/^HTTP\/\d\.\d (\d+)/)
        const status = statusMatch ? Number(statusMatch[1]) : 502

        const respHeaders = {}
        for (const line of headerText.split("\r\n").slice(1)) {
          const ci = line.indexOf(":")
          if (ci > 0) respHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim()
        }

        contentLength = Number(respHeaders["content-length"]) || -1

        const remaining = headerBuf.slice(idx + 4)
        if (remaining.length > 0) {
          const remBuf = Buffer.from(remaining, "utf8")
          chunks.push(remBuf)
          bodyBytes += remBuf.length
        }

        if (contentLength >= 0 && bodyBytes >= contentLength) {
          sock.destroy()
          return resolve(makeResponse(status, respHeaders, chunks))
        }
      } else {
        chunks.push(d)
        bodyBytes += d.length
        if (contentLength >= 0 && bodyBytes >= contentLength) {
          sock.destroy()
          resolve(makeResponse(status, undefined, chunks)) // status captured in closure
        }
      }
    })

    sock.on("close", () => {
      if (headerDone) resolve(makeResponse(200, {}, chunks))
      else reject(new Error("Connection closed before response"))
    })
    sock.on("error", e => { clearTimeout(timer); reject(e) })
  })
}

function makeResponse(status, headers, chunks) {
  const body = Buffer.concat(chunks).toString("utf8")
  return { ok: status >= 200 && status < 400, status, headers, text: () => Promise.resolve(body) }
}

/**
 * Generic fetch with proxy support.
 * No proxy → native fetch. Proxy + HTTPS → CONNECT tunnel. Proxy + HTTP → native fetch.
 */
export async function proxyFetch(urlStr, opts, proxyUri) {
  if (!proxyUri) return globalThis.fetch(urlStr, opts)
  const target = new URL(urlStr)
  if (target.protocol === "https:") return tunnelHttps(urlStr, opts, proxyUri)
  return globalThis.fetch(urlStr, opts) // HTTP: proxy forwarding rare, native fetch works
}
