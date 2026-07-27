/**
 * session.mjs — 会话持久化
 * 每个项目（按 cwd 哈希）最多保留 5 轮会话，按最后使用时间轮转。
 * 两种恢复需求分开存：agent 恢复（history）要上下文连续，用户恢复（display）要所见即所得。
 *
 * 文件布局：{hash}.json（当前）、{hash}.json.1~5（槽位）、{hash}.json.manifest（槽位元数据）
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { configDir } from "./config.mjs"

const MAX_SLOTS = 5

export function sessionPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(configDir, "sessions", `${hash}.json`)
}

function slotPath(cwd, n) { return sessionPath(cwd) + "." + n }
function manifestPath(cwd) { return sessionPath(cwd) + ".manifest" }

/** 原子写：先写临时文件再 rename 替换，防写入中途崩溃留下截断的 JSON 丢整个会话。
 *  rename 在 POSIX 上原子；Windows 上目标已存在时 Node 24 用 MoveFileExW+REPLACE_EXISTING 也能原子替换。
 *  某些旧 Windows 文件系统可能抛 EPERM，重试一次。 */
function writeSessionFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try {
    renameSync(tmp, p)
  } catch {
    // Windows 可能因防病毒锁/网络盘竞争而 rename 失败，删目标后重试
    try { unlinkSync(p) } catch {}
    try {
      renameSync(tmp, p)
      // rename 成功：清理临时文件
      try { unlinkSync(tmp) } catch {}
    } catch {
      // rename 仍失败：保留 tmp 作为兜底数据（下次读取会优先找主文件，找不到时 tmp 至少还在）
    }
  }
}

// ========== 槽位管理 ==========

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

/** 归档当前会话到空闲槽位——满了踢最老；exclude 指定一个不许被踢的槽位（switchToSlot 的目标槽） */
export function archiveCurrent(cwd, { exclude } = {}) {
  const src = sessionPath(cwd)
  if (!existsSync(src)) return
  const m = loadManifest(cwd)

  let slot
  // 只计数字 key 的槽位，排除 _currentName 等遗留非数字 key
  const entries = Object.entries(m.slots).filter(([n]) => /^\d+$/.test(n))
  if (entries.length < MAX_SLOTS) {
    slot = 1
    while (m.slots[slot]) slot++
  } else {
    const candidates = entries.filter(([n]) => Number(n) !== exclude)
    slot = Number((candidates.length ? candidates : entries).sort((a, b) => a[1] - b[1])[0][0])
  }

  const dst = slotPath(cwd, slot)
  // 复制（rename 会丢当前）；走原子写，防中途崩溃留下截断的 JSON 丢归档
  let data
  try {
    data = JSON.parse(readFileSync(src, "utf8"))
  } catch {
    // 会话文件损坏，放弃归档，下次保存会覆盖
    return
  }
  writeSessionFile(dst, data)
  m.slots[slot] = Date.now()
  delete m.slots._currentName
  saveManifest(cwd, m)
  return slot
}

/** 列出所有归档槽位，最新在前 */
export function listSlots(cwd) {
  const m = loadManifest(cwd)
  return Object.entries(m.slots)
    .map(([n, ts]) => ({ slot: Number(n), timestamp: ts, date: new Date(ts).toLocaleString() }))
    .sort((a, b) => b.timestamp - a.timestamp)
}

/** 切换到指定槽位：归档当前 → 槽位文件复制到当前 → 返回恢复数据（失败返回 null） */
export function switchToSlot(cwd, slot) {
  const m = loadManifest(cwd)
  if (!m.slots[slot]) return null

  // 归档当前（内部写 manifest；之后我们的 m 已过期，需重读）
  // 满槽时排除目标槽：否则最老槽=目标槽，归档会把目标覆盖掉再复制回来，目标会话永久丢失
  archiveCurrent(cwd, { exclude: slot })

  // 槽位文件 → 当前（copy+unlink，不用 rename：Windows rename 目标已存在会抛 EPERM）
  const src = slotPath(cwd, slot)
  const dst = sessionPath(cwd)
  if (!existsSync(src)) return null
  try {
    try { unlinkSync(dst) } catch { /* 不存在就算了 */ }
    copyFileSync(src, dst)
    unlinkSync(src)
  } catch {
    // 文件操作失败（磁盘满/权限不足/锁文件），放弃切换
    return null
  }

  // 重读 manifest（archiveCurrent 改了它）
  const m2 = loadManifest(cwd)
  delete m2.slots[slot]
  saveManifest(cwd, m2)

  return loadSession(cwd)
}

// ========== 旧版 transient 前缀清理 ==========

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

// ========== 核心读写 ==========

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

export function loadSession(cwd) {
  try {
    const p = sessionPath(cwd)
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (data?.version !== 1 && data?.version !== 2) return null
    if (!Array.isArray(data.history)) return null
    if (data.cwd && data.cwd.toLowerCase() !== cwd.toLowerCase()) return null
    data.history = data.history.filter((m) => !isLegacyTransient(m))
    data.display = Array.isArray(data.display)
      ? data.display.filter((l) => l && typeof l.text === "string").map((l) => ({ text: l.text, color: l.color }))
      : []
    return data
  } catch { return null }
}

export function applySession(agent, data) {
  agent.history = data.history
  agent.tasks = data.tasks ?? []
  agent.planMode = data.planMode ?? false
  agent.autoApprove = data.autoApprove ?? false
  agent.goal = data.goal ?? null
  agent._pendingReminders = data.pendingReminders ?? []
  agent._sessionStart = data.sessionStart ?? null
  // 重置轮次计数器：切换会话后不应继承旧会话的停滞/压缩状态
  agent._turnsSinceTaskUpdate = 0
  agent._turnsInPlanMode = 0
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

export function clearSession(cwd) {
  try {
    archiveCurrent(cwd)
    const p = sessionPath(cwd)
    writeSessionFile(p, { version: 2, cwd, history: [], tasks: [], display: [], goal: null, autoApprove: false, pendingReminders: [], sessionStart: null })
  } catch {
    // 清不掉就算了，下次保存会覆盖
  }
}
