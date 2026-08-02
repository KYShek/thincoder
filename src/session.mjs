/**
 * session.mjs — session persistence (slot-based model)
 * Each project (keyed by cwd hash) keeps up to 5 session slots.
 * Every session lives in a numbered slot; the manifest tracks which slot is active.
 * There is no separate "current" file — the active slot IS the current session.
 *
 * File layout: {hash}.json.1~5 (slots), {hash}.json.manifest (slot metadata + active pointer).
 * Legacy {hash}.json is migrated to a slot on first access.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { configDir } from "./config.mjs"

const MAX_SLOTS = 5
const CWD_HASH_LEN = 12

/** Derive base session path from cwd hash (legacy, kept for migration and tests) */
export function sessionPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LEN)
  return join(configDir, "sessions", `${hash}.json`)
}

function slotPath(cwd, n) { return sessionPath(cwd) + "." + n }
function manifestPath(cwd) { return sessionPath(cwd) + ".manifest" }

/** Path to the active slot's file */
export function activePath(cwd) {
  return slotPath(cwd, activeSlot(cwd))
}

/** Atomic write: write to temp file then rename to replace, preventing truncated JSON from mid-write crash. */
function writeSessionFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try {
    renameSync(tmp, p)
  } catch {
    try { unlinkSync(p) } catch {}
    try {
      renameSync(tmp, p)
      try { unlinkSync(tmp) } catch {}
    } catch {
      writeFileSync(p, readFileSync(tmp, "utf8"), "utf8")
    }
  }
}

// ========== slot management ==========

/** Normalize slot metadata: old format is a raw timestamp number; new format is { ts, ... } object */
function slotMetaTs(v) { return typeof v === "number" ? v : (v?.ts ?? 0) }

function slotCmp(a, b) { return slotMetaTs(a[1]) - slotMetaTs(b[1]) }

/** Detect a genuine user message (excludes system-reminder injected messages) */
function isRealUserMsg(m) {
  return m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[System reminder:")
}

/** Extract slot metadata from history (shared by slotDigest and loadSlotMeta) */
function extractSlotMeta(history, activeProvider, updatedAt) {
  const userMsgs = history.filter(isRealUserMsg)
  const first = userMsgs[0]?.content ?? ""
  return {
    messageCount: history.length,
    turnCount: userMsgs.length,
    firstMessage: first.slice(0, 80),
    activeProvider: activeProvider ?? "",
    updatedAt: updatedAt ?? Date.now(),
  }
}

/** Extract preview summary from session data for manifest storage (with current timestamp) */
function slotDigest(data) {
  const meta = extractSlotMeta(data.history ?? [], data.activeProvider, data.updatedAt)
  return { ts: Date.now(), ...meta }
}

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

/**
 * Ensure an active slot exists in the manifest, migrating legacy data if needed.
 * Called by activeSlot() — idempotent, safe to call repeatedly.
 */
function ensureActive(cwd, m) {
  // Already have an active slot
  if (m.active) return

  const legacy = sessionPath(cwd) // {hash}.json (old current file)

  // Migrate legacy current file if it exists
  if (existsSync(legacy)) {
    try {
      const data = JSON.parse(readFileSync(legacy, "utf8"))
      if (data && Array.isArray(data.history)) {
        const digest = slotDigest(data)
        // Check if any existing slot has matching content
        for (const [n, meta] of Object.entries(m.slots)) {
          if (typeof meta === "object" && meta.firstMessage === digest.firstMessage && meta.messageCount === digest.messageCount) {
            m.active = Number(n)
            saveManifest(cwd, m)
            try { unlinkSync(legacy) } catch {}
            return
          }
        }
        // No match — create a new slot from the legacy file
        let slot = 1
        while (m.slots[slot]) slot++
        const dst = slotPath(cwd, slot)
        writeSessionFile(dst, data)
        m.slots[slot] = digest
        m.active = slot
        saveManifest(cwd, m)
        try { unlinkSync(legacy) } catch {}
        return
      }
    } catch {
      // Corrupted legacy file — remove it
      try { unlinkSync(legacy) } catch {}
    }
  }

  // No legacy file — if slots exist, pick newest; otherwise create slot 1 (no file yet)
  const entries = Object.entries(m.slots).filter(([n]) => /^\d+$/.test(n))
  if (entries.length > 0) {
    m.active = Number(entries.sort((a, b) => slotMetaTs(b[1]) - slotMetaTs(a[1]))[0][0])
  } else {
    m.active = 1
  }
  saveManifest(cwd, m)
}

/** Return the active slot number, migrating legacy data if necessary */
export function activeSlot(cwd) {
  const m = loadManifest(cwd)
  if (!m.active) ensureActive(cwd, m)
  return m.active
}

/** Lazy-load slot metadata from slot file (for old-format manifest entries that lack metadata) */
function loadSlotMeta(cwd, slot, v) {
  if (typeof v === "object" && v !== null && "ts" in v) return v
  const ts = typeof v === "number" ? v : 0
  try {
    const p = slotPath(cwd, slot)
    if (!existsSync(p)) return { ts }
    const data = JSON.parse(readFileSync(p, "utf8"))
    const history = data.history ?? []
    const meta = extractSlotMeta(history, data.activeProvider, data.updatedAt ?? ts)
    return { ts, ...meta }
  } catch {
    return { ts }
  }
}

/** List all slots, newest first. Includes isActive flag. */
export function listSlots(cwd) {
  const m = loadManifest(cwd)
  const active = m.active ?? activeSlot(cwd)
  return Object.entries(m.slots)
    .filter(([n]) => /^\d+$/.test(n))
    .map(([n, v]) => {
      const meta = loadSlotMeta(cwd, Number(n), v)
      return {
        slot: Number(n),
        isActive: Number(n) === active,
        timestamp: meta.ts,
        date: new Date(meta.ts).toLocaleString(),
        messageCount: meta.messageCount ?? 0,
        turnCount: meta.turnCount ?? 0,
        firstMessage: meta.firstMessage ?? "",
        activeProvider: meta.activeProvider ?? "",
        updatedAt: meta.updatedAt ?? meta.ts,
        updatedDate: new Date(meta.updatedAt ?? meta.ts).toLocaleString(),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Switch active slot. No file copying — just change the pointer in the manifest.
 * Returns the loaded session data (null if slot doesn't exist).
 */
export function switchToSlot(cwd, slot) {
  const m = loadManifest(cwd)
  if (!m.slots[slot]) return null
  m.active = slot
  saveManifest(cwd, m)
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

/** Save agent state and display lines to the active slot file (atomic write) */
export function saveSession(agent, display) {
  const history = agent.history.filter((m) => !m.transient && !isLegacyTransient(m))
  const data = {
    version: 2,
    cwd: agent.cwd,
    activeProvider: agent.activeProvider ?? agent.provider?.name,
    activeModel: agent.activeModel ?? null,
    updatedAt: Date.now(),
    history,
    display: display ?? [],
    tasks: agent.tasks ?? [],
    planMode: agent.planMode ?? false,
    autoApprove: agent.autoApprove ?? false,
    engineering: agent.config?.agent?.engineering ?? false,
    engDesignToken: agent._engDesignToken ?? null,
    goal: agent.goal ?? null,
    advisor: agent.config?.advisor ?? null,
    pendingReminders: agent._pendingReminders ?? [],
    sessionStart: agent._sessionStart ?? null,
  }
  const slot = activeSlot(agent.cwd)
  writeSessionFile(slotPath(agent.cwd, slot), data)
  // Update slot metadata in manifest
  try {
    const m = loadManifest(agent.cwd)
    m.slots[slot] = slotDigest(data)
    saveManifest(agent.cwd, m)
  } catch (e) {
    // Manifest update failure is non-fatal — data is safe, metadata will lazy-recover on next listSlots
    console.error(`[session] manifest metadata update failed for slot ${slot}: ${e.message}`)
  }
}

/** Load session data from the active slot; returns null if missing, corrupted, or version mismatch */
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

  // Try the active slot first (post-migration, legacy file may be stale)
  const slot = activeSlot(cwd)
  const p = slotPath(cwd, slot)
  let result = tryLoad(p)
  if (result && !result._error) return result
  if (result?._error) {
    console.error(`[session] failed to load slot ${slot}: ${result._error.message}. Trying .tmp fallback...`)
    const tmpResult = tryLoad(`${p}.tmp`)
    if (tmpResult && !tmpResult._error) {
      console.error(`[session] recovered from .tmp fallback`)
      tmpResult._recovered = true
      return tmpResult
    }
    console.error(`[session] .tmp fallback also failed — session lost.`)
    try { renameSync(p, `${p}.corrupted`) } catch {}
  }

  // Fallback: try the legacy current file (pre-migration, or migration failed to clean up)
  const legacy = sessionPath(cwd)
  result = tryLoad(legacy)
  if (result && !result._error) {
    return result
  }
  if (result?._error) {
    console.error(`[session] failed to load legacy ${legacy}: ${result._error.message}`)
    try { renameSync(legacy, `${legacy}.corrupted`) } catch {}
  }

  return null
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
  agent._engDesignToken = data.engDesignToken ?? null
  if (data.advisor) {
    agent.config.advisor = { ...data.advisor }
  }
  // Reset stall/compaction state on session switch
  agent._compressFailures = 0
  agent._verifyRetries = 0
  agent._verifyPassed = false
  if (data.activeProvider && data.activeProvider !== agent.activeProvider) {
    const p = agent.providers?.find((pr) => pr.name === data.activeProvider)
    if (p) {
      agent.provider = { ...p }
      agent.activeProvider = p.name
      agent.activeModel = data.activeModel ?? null
      if (agent.activeModel) agent.provider.model = agent.activeModel
      return true
    }
  } else if (data.activeModel != null) {
    // Same provider, different model
    agent.activeModel = data.activeModel
    if (agent.activeModel && agent.provider) agent.provider.model = agent.activeModel
  } else if (data.activeProvider && data.activeProvider === agent.activeProvider) {
    // Same provider, session has no activeModel → clear stale override
    agent.activeModel = null
    if (agent.provider) {
      const p = agent.providers?.find((pr) => pr.name === agent.activeProvider)
      if (p) agent.provider.model = p.model
    }
  }
  return false
}

/**
 * Create a new session slot: allocate a free slot number,
 * write an empty session, and mark it as the active slot.
 * Evicts the oldest slot if MAX_SLOTS is reached.
 */
export function newSession(cwd) {
  const m = loadManifest(cwd)
  // Ensure active is set (migrate if needed)
  if (!m.active) ensureActive(cwd, m)

  let slot
  const entries = Object.entries(m.slots).filter(([n]) => /^\d+$/.test(n))
  if (entries.length < MAX_SLOTS) {
    slot = 1
    while (m.slots[slot]) slot++
  } else {
    // Full — evict oldest (but never evict the currently active slot)
    const candidates = entries.filter(([n]) => Number(n) !== m.active)
    if (candidates.length === 0) {
      // Should not happen with MAX_SLOTS >= 2 — manifest corruption or all slots are active
      console.error(`[session] newSession: all ${entries.length} slots are active, cannot evict. Overwriting oldest non-active slot skipped; reusing slot 1.`)
      slot = 1
    } else {
      slot = Number(candidates.sort(slotCmp)[0][0])
    }
    // Delete the evicted slot file
    try { unlinkSync(slotPath(cwd, slot)) } catch {}
  }

  // Write empty session
  const data = { version: 2, cwd, updatedAt: Date.now(), history: [], tasks: [], display: [], goal: null, autoApprove: false, advisor: null, pendingReminders: [], sessionStart: null }
  writeSessionFile(slotPath(cwd, slot), data)
  m.slots[slot] = slotDigest(data)
  m.active = slot
  saveManifest(cwd, m)
  return slot
}
