/**
 * mcp/transport-stdio.mjs — MCP stdio transport
 */
import { spawn } from "node:child_process"
import { rpcId, CALL_TIMEOUT_MS, withTimeout, quoteArg } from "./helpers.mjs"

/** Create an MCP stdio transport over a spawned child process.
 *  @param {Object} [env] — extra environment variables merged on top of process.env */
export function stdioTransport(command, args, env) {
  const spawnOptions = { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } }
  const child =
    process.platform === "win32" && !/\.exe$/i.test(command)
      ? spawn("cmd.exe", ["/d", "/s", "/c", [command, ...(args ?? [])].map(quoteArg).join(" ")], {
          ...spawnOptions,
          windowsVerbatimArguments: true,
        })
      : spawn(command, args ?? [], spawnOptions)

  const pending = new Map()
  const decoder = new TextDecoder()
  let buffer = ""
  let stderrTail = ""
  let spawnError = null
  let closed = false

  const failAll = (message) => {
    for (const [, resolve] of pending) resolve({ id: null, error: { code: -32000, message } })
    pending.clear()
  }

  child.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const resolver = pending.get(msg.id)
        if (resolver) {
          pending.delete(msg.id)
          resolver(msg)
        }
      } catch { /* non-JSON line, ignore */ }
    }
  })

  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })

  child.stdin.on("error", () => {})
  child.on("error", (error) => {
    spawnError = error
    closed = true
    failAll(`spawn failed: ${error.message}`)
  })
  child.on("close", () => {
    closed = true
    const lastLine = stderrTail.trim().split("\n").pop()
    failAll(`Connection closed${lastLine ? ` | stderr: ${lastLine}` : ""}`)
  })

  const send = (method, params) => {
    if (spawnError) return Promise.resolve({ id: null, error: { code: -32000, message: `spawn failed: ${spawnError.message}` } })
    if (closed) return Promise.reject(new Error("MCP connection closed"))
    const id = rpcId()
    const promise = new Promise((resolve) => pending.set(id, resolve))
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    } catch (error) {
      pending.delete(id)
      return Promise.resolve({ id: null, error: { code: -32000, message: `stdin write failed: ${error.message}` } })
    }
    return withTimeout(promise, CALL_TIMEOUT_MS).finally(() => pending.delete(id))
  }

  const notify = (method, params) => {
    if (closed) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    } catch { /* ignore */ }
  }

  return { send, notify, close: () => { if (!closed) child.kill() } }
}
