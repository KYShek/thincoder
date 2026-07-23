/**
 * session.mjs — 会话持久化
 * 每个项目（按 cwd 哈希）保存最近一个会话到 ~/.thincoder/sessions/。
 * 退出时存、启动时恢复；agent.history 本来就是可 JSON 序列化的。
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { configDir } from "./config.mjs"

export function sessionPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(configDir, "sessions", `${hash}.json`)
}

/** 保存会话（同步：退出清理路径也能用） */
export function saveSession(agent) {
  const data = {
    version: 1,
    cwd: agent.cwd,
    model: agent.provider.model,
    updatedAt: Date.now(),
    history: agent.history,
    tasks: agent.tasks ?? [],
  }
  const p = sessionPath(agent.cwd)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(data), "utf8")
}

/** 恢复会话。没有或损坏返回 null */
export function loadSession(cwd) {
  try {
    const p = sessionPath(cwd)
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (data?.version !== 1 || !Array.isArray(data.history)) return null
    return data
  } catch {
    return null
  }
}

/** 清空会话（/new） */
export function clearSession(cwd) {
  try {
    const p = sessionPath(cwd)
    if (existsSync(p)) writeFileSync(p, JSON.stringify({ version: 1, cwd, history: [], tasks: [] }), "utf8")
  } catch {
    // 清不掉就算了，下次保存会覆盖
  }
}
