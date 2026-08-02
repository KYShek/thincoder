/**
 * session-compaction.test.mjs — verify that compaction never destroys the persisted full history.
 *
 * Regression coverage for the bug where the CLI's single agent.history doubled as both the machine
 * context AND the persistence source: once compaction replaced it, saveSession wrote the shrunk
 * history to disk, so the VS Code history panel (and CLI resume fallback) lost all pre-compaction
 * content. The fix keeps a never-compacted agent._fullHistory and double-writes the session file:
 *   history        = full, never-compacted (human-readable)
 *   contextHistory = machine context (possibly compacted)
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { compressFallback, pushReal } from "../src/context.mjs"
import { saveSession, loadSession, applySession, sessionPath } from "../src/session.mjs"

/** Build a long, splittable history (alternating user/assistant so splitHistory finds a middle). */
function makeHistory(exchanges) {
  const h = []
  for (let i = 0; i < exchanges; i++) {
    h.push({ role: "user", content: `user message ${i} ${"x".repeat(50)}` })
    h.push({ role: "assistant", content: `assistant reply ${i} ${"y".repeat(50)}` })
  }
  return h
}

/** Minimal agent shape needed by context.mjs + session.mjs. */
function makeAgent(cwd, history) {
  const agent = {
    cwd,
    history: [],
    _fullHistory: [],
    tasks: [],
    planMode: false,
    autoApprove: false,
    config: {},
    providers: [],
  }
  // Seed via pushReal — mirrors the source double-write so both lines hold the real messages.
  for (const m of history) pushReal(agent, m)
  return agent
}

/** Remove every file this cwd's session may have created (slots + manifest + legacy). */
function cleanup(cwd) {
  const base = sessionPath(cwd)
  for (const suffix of ["", ".manifest", ".1", ".2", ".3", ".tmp", ".corrupted"]) {
    try { if (existsSync(base + suffix)) unlinkSync(base + suffix) } catch {}
  }
}

test("compaction preserves full history in _fullHistory while shrinking agent.history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sess-cmp-"))
  try {
    const full = makeHistory(20) // 40 messages, splittable
    const agent = makeAgent(cwd, [...full])

    const ok = compressFallback(agent)
    assert.equal(ok, true, "fallback compaction should succeed on a long history")

    // Machine context shrank; full record kept every original message.
    assert.ok(agent.history.length < full.length, "agent.history should be compacted")
    assert.equal(agent._fullHistory.length, full.length, "_fullHistory must keep all pre-compaction messages")
    // The compacted-away middle content is still present in the full record.
    assert.ok(
      agent._fullHistory.some((m) => m.content.includes("user message 5")),
      "middle messages compacted out of agent.history must survive in _fullHistory"
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("saveSession double-writes full history + compacted contextHistory; loadSession returns full history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sess-cmp-"))
  try {
    const full = makeHistory(20)
    const agent = makeAgent(cwd, [...full])
    compressFallback(agent) // compact BEFORE saving — the regression scenario

    saveSession(agent, [])
    const data = loadSession(cwd)
    assert.ok(data, "session should load")

    // history field = full, never-compacted (what the VS Code panel & CLI resume read).
    assert.equal(data.history.length, full.length, "persisted history must be the full record")
    assert.ok(
      data.history.some((m) => m.content.includes("user message 5")),
      "persisted history must retain compacted-away content"
    )
    // contextHistory field = the compacted machine context.
    assert.ok(Array.isArray(data.contextHistory), "contextHistory must be persisted")
    assert.ok(
      data.contextHistory.length < data.history.length,
      "contextHistory should be the compacted (shorter) machine context"
    )
  } finally {
    cleanup(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("applySession resumes machine context from full history and reseeds _fullHistory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sess-cmp-"))
  try {
    const full = makeHistory(20)
    const writer = makeAgent(cwd, [...full])
    compressFallback(writer)
    saveSession(writer, [])

    const data = loadSession(cwd)
    const reader = makeAgent(cwd, [])
    applySession(reader, data)

    // Correctness over token savings: resume seeds the machine context from the FULL history.
    assert.equal(reader.history.length, full.length, "resumed machine context should be the full history")
    assert.equal(reader._fullHistory.length, full.length, "_fullHistory reseeded from full record")

    // A post-resume exchange appends to BOTH the machine context and the full record via pushReal.
    pushReal(reader, { role: "user", content: "post-resume question" })
    pushReal(reader, { role: "assistant", content: "post-resume answer" })
    assert.equal(reader._fullHistory.length, full.length + 2, "new exchange appended onto full history")
    assert.ok(reader._fullHistory.some((m) => m.content === "post-resume question"))
  } finally {
    cleanup(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("legacy session file without contextHistory still loads (backwards compatible)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sess-cmp-"))
  try {
    const full = makeHistory(4)
    const agent = makeAgent(cwd, [...full])
    // Never compact: simulates an old session written before the contextHistory field existed.
    saveSession(agent, [])
    const data = loadSession(cwd)
    // Strip the field to emulate a legacy file, then re-apply.
    delete data.contextHistory
    const reader = makeAgent(cwd, [])
    applySession(reader, data)
    assert.equal(reader.history.length, full.length, "falls back to full history when contextHistory absent")
    assert.equal(reader._fullHistory.length, full.length)
  } finally {
    cleanup(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})
