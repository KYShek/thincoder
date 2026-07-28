/**
 * session.mjs — session persistence
 * Each project (keyed by cwd hash) keeps up to 5 session slots, rotated by last-access time.
 * Two recovery needs stored separately: agent recovery (history) needs context continuity, user recovery (display) needs WYSIWYG.
 *
 * File layout: {hash}.json (current), {hash}.json.1~5 (slots), {hash}.json.manifest (slot metadata)
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { configDir } from "./config.mjs"

const MAX_SLOTS = 5
const CWD_HASH_LEN = 12

/** Derive session file path from cwd hash */
export function sessionPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LEN)
  return join(configDir, "sessions", `${hash}.json`)
}

function slotPath(cwd, n) { return sessionPath(cwd) + "." + n }
function manifestPath(cwd) { return sessionPath(cwd) + ".manifest" }

/** Atomic write: write to temp file then rename to replace, preventing truncated JSON from mid-write crash.
 *  rename is atomic on POSIX; on Windows with existing target, Node 24 uses MoveFileExW+REPLACE_EXISTING for atomic replace.
 *  Some older Windows filesystems may throw EPERM — retry once. */
function writeSessionFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try {
    renameSync(tmp, p)
  } catch {
    // Windows: rename may fail due to antivirus lock / network drive contention — delete target and retry
    try { unlinkSync(p) } catch {}
    try {
      renameSync(tmp, p)
      // rename succeeded: clean up temp file
      try { unlinkSync(tmp) } catch {}
    } catch {
      // rename still failed: keep tmp as fallback data (next read prefers main file; if missing, tmp is at least there)
    }
  }
}

// ========== slot management ==========

function loadManifest(cwd) {
  try {
    const p = manifestPath(cwd)
    if (!existsSync(p)) return { slots: {} }
    return JSON.parse(readFileSync(p, "utf8"))
  } catch { return { slots: {} } }
}

function saveManifest(cwd, m) {
  writeSessionFile(manifestPath(cwd), m)
}

/** Archive current session to a free slot — evict oldest if full; exclude specifies a slot that must not be evicted (switchToSlot target) */
export function archiveCurrent(cwd, { exclude } = {}) {
  const src = sessionPath(cwd)
  if (!existsSync(src)) return
  const m = loadManifest(cwd)

  let slot
  // Only count numeric-keyed slots, exclude legacy non-numeric keys like _currentName
  const entries = Object.entries(m.slots).filter(([n]) => /^\d+$/.test(n))
  if (entries.length < MAX_SLOTS) {
    slot = 1
    while (m.slots[slot]) slot++
  } else {
    const candidates = entries.filter(([n]) => Number(n) !== exclude)
    slot = Number((candidates.length ? candidates : entries).sort((a, b) => a[1] - b[1])[0][0])
  }

  const dst = slotPath(cwd, slot)
  // Copy (rename would lose current); use atomic write to prevent truncated JSON in archive from mid-crash
  let data
  try {
    data = JSON.parse(readFileSync(src, "utf8"))
  } catch {
    // Session file corrupted, abandon archive; next save will overwrite
    return
  }
  writeSessionFile(dst, data)
  m.slots[slot] = Date.now()
  delete m.slots._currentName
  saveManifest(cwd, m)
  return slot
}

/** List all archive slots, newest first */
export function listSlots(cwd) {
  const m = loadManifest(cwd)
  return Object.entries(m.slots)
    .map(([n, ts]) => ({ slot: Number(n), timestamp: ts, date: new Date(ts).toLocaleString() }))
    .sort((a, b) => b.timestamp - a.timestamp)
}

/** Switch to a specific slot: archive current → copy slot file to current → return recovered data (null on failure) */
export function switchToSlot(cwd, slot) {
  const m = loadManifest(cwd)
  if (!m.slots[slot]) return null

  // Archive current (internally writes manifest; our `m` is stale after, must reload)
  // When full, exclude target slot: otherwise oldest=target, archive would overwrite target then copy back, permanently losing the target session
  archiveCurrent(cwd, { exclude: slot })

  // Slot file → current (copy+unlink, not rename: Windows rename on existing target throws EPERM)
  const src = slotPath(cwd, slot)
  const dst = sessionPath(cwd)
  if (!existsSync(src)) return null
  try {
    try { unlinkSync(dst) } catch { /* doesn't exist, that's fine */ }
    copyFileSync(src, dst)
    unlinkSync(src)
  } catch {
    // File operations failed (disk full / permissions / lock), abandon switch
    return null
  }

  // Reload manifest (archiveCurrent modified it)
  const m2 = loadManifest(cwd)
  delete m2.slots[slot]
  saveManifest(cwd, m2)

  return loadSession(cwd)
}

// ========== legacy transient prefix cleanup ==========

const LEGACY_TRANSIENT_PREFIXES = [
  "[System reminder: working directory snapshot:",
  "[Relevant memories from previous sessions",
]

function isLegacyTransient(m) {
  return (
    m.role === "user" &&
    typeof m.content === "string" &&
    LEGACY_TRANSIENT_PREFIXES.some((p) => m.content.startsWith(p))
  )
}

// ========== core read/write ==========

/** Save agent state and display lines to the session file (atomic write) */
export function saveSession(agent, display) {
  const history = agent.history.filter((m) => !m.transient && !isLegacyTransient(m))
  const data = {
    version: 2,
    cwd: agent.cwd,
    activeProvider: agent.activeProvider ?? agent.provider?.name,
    updatedAt: Date.now(),
    history,
    display: display ?? [],
    tasks: agent.tasks ?? [],
    planMode: agent.planMode ?? false,
    autoApprove: agent.autoApprove ?? false,
    goal: agent.goal ?? null,
    pendingReminders: agent._pendingReminders ?? [],
    sessionStart: agent._sessionStart ?? null,
  }
  writeSessionFile(sessionPath(agent.cwd), data)
}

/** Load session data from disk; returns null if missing, corrupted, or version mismatch */
export function loadSession(cwd) {
  const tryLoad = (p) => {
    try {
      if (!existsSync(p)) return null
      const data = JSON.parse(readFileSync(p, "utf8"))
      if (data?.version !== 1 && data?.version !== 2) return null
      if (!Array.isArray(data.history)) return null
      if (data.cwd && data.cwd.toLowerCase() !== cwd.toLowerCase()) return null
      data.history = data.history.filter((m) => !isLegacyTransient(m))
      data.display = Array.isArray(data.display)
        ? data.display.filter((l) => l && typeof l.text === "string").map((l) => ({ text: l.text, color: l.color }))
        : []
      data._recovered = false
      return data
    } catch (e) {
      return { _error: e }
    }
  }
  const p = sessionPath(cwd)
  let result = tryLoad(p)
  if (result?._error) {
    // Main file corrupted — try the .tmp fallback from a failed atomic write
    console.error(`[session] failed to load ${p}: ${result._error.message}. Trying .tmp fallback...`)
    const tmpResult = tryLoad(`${p}.tmp`)
    if (tmpResult && !tmpResult._error) {
      console.error(`[session] recovered from .tmp fallback`)
      result = tmpResult
      result._recovered = true
    } else {
      console.error(`[session] .tmp fallback also failed — session lost. Backing up corrupted file as .corrupted.`)
      try { renameSync(p, `${p}.corrupted`) } catch (e) { console.error(`[session] rename to .corrupted also failed: ${e.message}`) }
      return null
    }
  }
  return result && !result._error ? result : null
}

/** Apply loaded session data onto an agent object; returns true if provider was switched */
export function applySession(agent, data) {
  agent.history = data.history
  agent.tasks = data.tasks ?? []
  agent.planMode = data.planMode ?? false
  agent.autoApprove = data.autoApprove ?? false
  agent.goal = data.goal ?? null
  agent._pendingReminders = data.pendingReminders ?? []
  agent._sessionStart = data.sessionStart ?? null
  // Reset stall/compaction state on session switch
  agent._compressFailures = 0
  agent._verifyRetries = 0
  agent._verifyPassed = false
  if (data.activeProvider && data.activeProvider !== agent.activeProvider) {
    const p = agent.providers?.find((pr) => pr.name === data.activeProvider)
    if (p) {
      agent.provider = { ...p }
      agent.activeProvider = p.name
      return true
    }
  }
  return false
}

/** Archive current session and reset the session file to empty state */
export function clearSession(cwd) {
  try {
    archiveCurrent(cwd)
    const p = sessionPath(cwd)
    writeSessionFile(p, { version: 2, cwd, history: [], tasks: [], display: [], goal: null, autoApprove: false, pendingReminders: [], sessionStart: null })
  } catch {
    // Can't clear, oh well — next save will overwrite
  }
}
