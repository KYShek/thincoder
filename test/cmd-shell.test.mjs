/**
 * cmd-shell.test.mjs — /shell command: platform-aware picker + direct args.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

function makeCtx(initialShell = null, pickerResult = null) {
  const calls = []
  const agent = { config: { shell: initialShell } }
  const ctx = {
    agent,
    pushLine: (t) => calls.push(t),
    showPicker: async () => pickerResult,
    askQuestion: async () => "C:\\custom\\shell.exe",
    persistRaw: async (fn) => {
      const raw = { ...agent.config }
      fn(raw)
      agent.config = { ...agent.config, ...raw }
      calls.push(`persist:${JSON.stringify(raw)}`)
    },
  }
  return { ctx, calls, agent }
}

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
})

test("/shell picker: system default entry resets to null", async () => {
  const { ctx, agent } = makeCtx("pwsh", { action: "pick", value: null })
  await handleShellCommand(ctx, [])
  assert.equal(agent.config.shell, null, "system default pick resets")
})

test("/shell picker: picked shell persists", async () => {
  const { ctx, agent } = makeCtx(null, { action: "pick", value: "pwsh" })
  await handleShellCommand(ctx, [])
  assert.equal(agent.config.shell, "pwsh")
})

test("/shell picker: custom path flow uses askQuestion", async () => {
  const { ctx, agent } = makeCtx(null, { action: "custom" })
  await handleShellCommand(ctx, [])
  assert.equal(agent.config.shell, "C:\\custom\\shell.exe")
})

import { handleShellCommand } from "../src/tui/cmd-shell.mjs"
