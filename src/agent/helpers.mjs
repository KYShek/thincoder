/**
 * agent/helpers.mjs — Agent 工具函数与常量
 */
import { configDir } from "../config.mjs"
import { readFileSync, readdirSync } from "node:fs"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { execSync } from "node:child_process"

export const DEFAULT_MAX_TURNS = 100
export const DEFAULT_SUBAGENT_TURNS = 20
export const DEFAULT_GOAL_TURNS = 200
export const MIN_REPORT_CHARS = 200
export const REPORT_CONTINUATION =
  "Your report is too brief to be a complete handoff — the parent agent sees nothing else from your run. " +
  "Expand it: what you did and why, the path of every file you touched, how you verified (commands/tests run, with results), and anything left undone."

const TOOL_RESULT_OFFLOAD_LIMIT = 16_000
const TOOL_RESULT_PREVIEW = 2_000

export const OUTLINE_INJECT_PREFIX = "[System reminder: project dependency outline:"
export const FILE_MUTATORS = new Set(["write", "edit", "insert_after", "apply_patch", "delete"])

export function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function tryCanonicalize(name, args) {
  try { return name + ":" + JSON.stringify(JSON.parse(args)) } catch { return name + ":" + args }
}

export async function offloadToolResult(text, callId) {
  if (text.length <= TOOL_RESULT_OFFLOAD_LIMIT) return text
  try {
    const dir = join(configDir, "tool-results")
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${String(callId).replace(/[^a-zA-Z0-9_-]/g, "_")}.log`)
    await writeFile(file, text, "utf8")
    return (
      text.slice(0, TOOL_RESULT_PREVIEW) +
      `\n\n[... output too large (${text.length} chars total), full content saved to: ${file}\n` +
      `Page through it with the read tool (offset/limit) or sed -n 'START,ENDp' — do NOT re-run the tool blindly.]`
    )
  } catch {
    return text.slice(0, TOOL_RESULT_OFFLOAD_LIMIT) + `\n\n[... truncated: ${text.length} chars total, offload to disk failed]`
  }
}

export function collectGitContext(cwd) {
  try {
    const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    const branch = execSync("git branch --show-current", opts).trim()
    const log = execSync("git --no-pager log --oneline -5", opts).trim()
    const status = execSync("git status --short", opts).trim()
    const dirty = status ? status.split("\n").length : 0
    return [
      `Git context: on branch \`${branch || "(detached)"}\`${dirty ? `, ${dirty} uncommitted change(s)` : ", working tree clean"}.`,
      log ? `Recent commits:\n${log}` : "",
      status ? `Uncommitted:\n${status.split("\n").slice(0, 20).join("\n")}${dirty > 20 ? `\n… (${dirty - 20} more)` : ""}` : "",
    ].filter(Boolean).join("\n")
  } catch {
    return ""
  }
}

export class ContinueError extends Error {
  constructor(turn) {
    super(`Agent paused after ${turn} turns. Continue?`)
    this.name = "ContinueError"
    this.turn = turn
  }
}

export function repairHistory(history) {
  const out = []
  let dirty = false
  const knownIds = new Set() // 迄今 assistant 声明过的 tool_call id
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    // 空 assistant 消息：无正文且无 tool_calls，丢弃
    if (m.role === "assistant" && !m.tool_calls?.length && !m.content) {
      dirty = true
      continue
    }
    // 孤儿 tool 消息：没有对应的 assistant tool_calls 声明，丢弃
    if (m.role === "tool" && !knownIds.has(m.tool_call_id)) {
      dirty = true
      continue
    }
    out.push(m)
    if (m.role !== "assistant" || !m.tool_calls?.length) continue

    for (const tc of m.tool_calls) knownIds.add(tc.id)
    // 收集紧随其后（下一个非 tool 消息之前）的 tool 结果 id
    const answered = new Set()
    let j = i + 1
    while (j < history.length && history[j].role === "tool") {
      if (knownIds.has(history[j].tool_call_id)) {
        answered.add(history[j].tool_call_id)
        out.push(history[j])
      } else {
        dirty = true // 孤儿 tool 结果，丢弃
      }
      j++
    }
    i = j - 1 // 外层 for 会再 +1

    for (const tc of m.tool_calls) {
      if (!answered.has(tc.id)) {
        dirty = true
        out.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "[Tool execution was interrupted: session ended before the result was recorded]",
        })
      }
    }
  }
  return dirty ? out : history
}

export function listWorkDir(cwd, { rootMax = 30, subMax = 10 } = {}) {
  const SKIP = new Set([".git", "node_modules"])
  let entries
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return ""
  }
  const visible = entries.filter((e) => !e.name.startsWith("."))
  const hiddenCount = entries.length - visible.length
  const byName = (a, b) => a.name.localeCompare(b.name)
  const dirs = visible.filter((e) => e.isDirectory() && !SKIP.has(e.name)).sort(byName)
  const files = visible.filter((e) => !e.isDirectory()).sort(byName)
  const ordered = [...dirs, ...files]
  const lines = []
  for (const e of ordered.slice(0, rootMax)) {
    if (!e.isDirectory()) {
      lines.push(e.name)
      continue
    }
    lines.push(`${e.name}/`)
    let children
    try {
      children = readdirSync(join(cwd, e.name)).filter((n) => !n.startsWith(".")).sort()
    } catch {
      continue
    }
    if (children.length <= subMax) {
      for (const c of children) lines.push(`  ${c}`)
    } else {
      for (const c of children.slice(0, subMax)) lines.push(`  ${c}`)
      lines.push(`  (${children.length - subMax} more entries omitted)`)
    }
  }
  if (ordered.length > rootMax) lines.push(`(${ordered.length - rootMax} more entries omitted)`)
  if (hiddenCount > 0) lines.push(`(${hiddenCount} hidden entries omitted)`)
  return lines.join("\n")
}

export function readonlyToolNames(tools) {
  return new Set(tools.filter((t) => t.readonly).map((t) => t.name))
}

const MAX_INSTRUCTION_CHARS = 32_000

export async function loadProjectInstructions(cwd) {
  const parts = []
  for (const name of ["AGENTS.md", "project_rules.md"]) {
    try {
      const content = readFileSync(join(cwd, name), "utf8").trim()
      if (!content) continue
      const key = name.toLowerCase()
      parts.push(`<!-- From: ${join(cwd, name)} -->\n${content}`)
    } catch { /* 文件不存在 */ }
  }
  const merged = parts.join("\n\n")
  if (!merged) return ""
  if (merged.length <= MAX_INSTRUCTION_CHARS) return merged
  return (
    `<!-- WARNING: project instructions total ${merged.length} chars, exceeding the ${MAX_INSTRUCTION_CHARS} soft limit. ` +
    `They are included in full, but consider shortening them — long instructions dilute attention. -->\n\n` +
    merged
  )
}
