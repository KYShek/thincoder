/**
 * session.mjs — 会话持久化
 * 每个项目（按 cwd 哈希）保存最近一个会话到 ~/.thincoder/sessions/。
 * 两种恢复需求分开存：agent 恢复（history）要上下文连续，用户恢复（display）要所见即所得。
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { configDir } from "./config.mjs"

export function sessionPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(configDir, "sessions", `${hash}.json`)
}

/** 原子写：先写临时文件再 rename，防写入中途崩溃留下截断的 JSON 丢整个会话 */
function writeSessionFile(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  renameSync(tmp, p)
}

/**
 * 旧版本会话里临时上下文是按文本前缀识别过滤的；
 * 现改为注入时打 transient 标记（见 agent.mjs），此前缀列表仅用于清理旧存档。
 */
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

/** 保存会话（同步：退出清理路径也能用） */
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

/** 恢复会话。没有、损坏或属于其他目录返回 null */
export function loadSession(cwd) {
  try {
    const p = sessionPath(cwd)
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (data?.version !== 1 && data?.version !== 2) return null
    if (!Array.isArray(data.history)) return null
    // cwd 大小写不敏感校验（Windows）
    if (data.cwd && data.cwd.toLowerCase() !== cwd.toLowerCase()) return null
    // 顺手清掉旧存档里的文本前缀型临时上下文
    data.history = data.history.filter((m) => !isLegacyTransient(m))
    // display schema 校验：非数组/畸形元素净化，防启动时崩溃
    data.display = Array.isArray(data.display)
      ? data.display.filter((l) => l && typeof l.text === "string").map((l) => ({ text: l.text, color: l.color }))
      : []
    return data
  } catch {
    return null
  }
}

/**
 * 把恢复的会话数据应用到 agent，返回是否切换了 provider。
 */
export function applySession(agent, data) {
  agent.history = data.history
  agent.tasks = data.tasks ?? []
  agent.planMode = data.planMode ?? false
  agent.autoApprove = data.autoApprove ?? false
  agent.goal = data.goal ?? null
  agent._pendingReminders = data.pendingReminders ?? []
  agent._sessionStart = data.sessionStart ?? null
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

/** 清空会话（/new） */
export function clearSession(cwd) {
  try {
    const p = sessionPath(cwd)
    if (existsSync(p)) writeSessionFile(p, { version: 2, cwd, history: [], tasks: [], display: [], goal: null, autoApprove: false, pendingReminders: [], sessionStart: null })
  } catch {
    // 清不掉就算了，下次保存会覆盖
  }
}
