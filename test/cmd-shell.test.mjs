/**
 * cmd-shell.test.mjs — /shell command: show/set/reset the bash-tool shell.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

function makeCtx(initialShell = null) {
  const calls = []
  const agent = { config: { shell: initialShell } }
  const ctx = {
    agent,
    pushLine: (t) => calls.push(t),
    persistRaw: async (fn) => {
      const raw = { ...agent.config }
      fn(raw)
      agent.config = { ...agent.config, ...raw }
      calls.push(`persist:${JSON.stringify(raw)}`)
    },
  }
  return { ctx, calls, agent }
}

test("/shell with no args shows current shell and usage", async () => {
  const { ctx, calls } = makeCtx()
  await handleShellCommand(ctx, [])
  assert.ok(calls.some((c) => c.includes("Shell:")), "shows current shell")
  assert.ok(calls.some((c) => c.includes("Usage:")), "shows usage")
})

test("/shell <path> sets and persists the shell", async () => {
  const { ctx, calls, agent } = makeCtx()
  await handleShellCommand(ctx, ["pwsh"])
  assert.equal(agent.config.shell, "pwsh", "in-memory config updated")
  assert.ok(calls.some((c) => c.includes('"shell":"pwsh"')), "persisted to config")
})

test("/shell with quoted path strips the quotes", async () => {
  const { ctx, agent } = makeCtx()
  await handleShellCommand(ctx, ['"C:\\Program Files\\Git\\bin\\bash.exe"'])
  assert.equal(agent.config.shell, "C:\\Program Files\\Git\\bin\\bash.exe", "no literal quotes")
})

test("/shell reset restores the default (case-insensitive)", async () => {
  const { ctx, agent } = makeCtx("pwsh")
  await handleShellCommand(ctx, ["RESET"])
  assert.equal(agent.config.shell, null, "reset is case-insensitive")
  await handleShellCommand(ctx, ["reset"])
  assert.equal(agent.config.shell, null)
})

import { handleShellCommand } from "../src/tui/cmd-shell.mjs"
