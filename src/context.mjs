/**
 * context.mjs — 上下文管理与压缩
 * token 用 length/4 粗估（不引 tokenizer 依赖）。
 * 压缩策略：保留最早 2 条 + 最近 N 条，中间由 LLM 摘要成一条（学 kimi-code，简化版）。
 */

import { chat } from "./provider.mjs"

/** 粗估一组消息的 token 数（正文 + 思考链 + tool_calls 参数） */
export function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length
    if (typeof m.reasoning_content === "string") chars += m.reasoning_content.length
    for (const tc of m.tool_calls ?? []) {
      chars += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0)
    }
  }
  return Math.ceil(chars / 4)
}

const KEEP_HEAD = 2 // 最早的用户意图，不能丢
const KEEP_TAIL = 10 // 最近的工作现场，不能丢

const SUMMARIZE_PROMPT = `你是一个对话压缩器。把下面的 agent 工作记录压缩成一份紧凑的摘要，供后续对话作为上下文使用。
要求：
- 保留：用户的原始需求、做出的决策、修改过的文件及原因、未解决的问题、下一步计划
- 丢弃：客套话、重复内容、工具输出的细枝末节
- 用中文条目式输出，控制在 500 字以内

工作记录：
`

/** 压缩后的上下文前缀，告知 agent 发生了什么 */
const COMPACTION_PREFIX =
  "[Context was automatically compacted. Below is a summary of earlier work. " +
  "Trust its conclusions — don't redo what it reports as done — but re-verify " +
  "transient state (open files, running processes) with tools.]\n\n"

/**
 * 如果历史超长则压缩。返回是否发生了压缩。
 * 只在循环的安全点调用（history 末尾是 user 消息时）。
 * 压缩后自动回注 task 列表状态。
 */
export async function compressIfNeeded(agent, threshold) {
  const history = agent.history
  if (estimateTokens(history) <= threshold) return false
  if (history.length <= KEEP_HEAD + KEEP_TAIL + 1) return false

  // 切分：head / middle(被摘要) / tail
  // tail 起点必须避开孤儿 tool 消息（其 assistant tool_calls 在 middle 里无妨，middle 会被整体摘要成纯文本）
  let tailStart = history.length - KEEP_TAIL
  while (tailStart > KEEP_HEAD && history[tailStart].role === "tool") {
    tailStart++
  }
  if (tailStart <= KEEP_HEAD) return false // 没有可压缩的中间段

  const head = history.slice(0, KEEP_HEAD)
  const middle = history.slice(KEEP_HEAD, tailStart)
  const tail = history.slice(tailStart)

  const serialized = middle
    .map((m) => {
      const toolNote = m.tool_calls ? ` [调用了工具: ${m.tool_calls.map((t) => t.function.name).join(", ")}]` : ""
      const content = typeof m.content === "string" ? m.content.slice(0, 2000) : ""
      return `[${m.role}]${toolNote} ${content}`
    })
    .join("\n")

  const summary = await chat(agent.provider, {
    messages: [{ role: "user", content: SUMMARIZE_PROMPT + serialized }],
  })

  // 摘要正文内嵌 task 快照（对齐 kimi-code 的 postProcessSummary）——
  // 否则二次压缩时 task 列表会随旧提醒消息一起被摘要器丢掉
  let compacted = COMPACTION_PREFIX + summary.content
  if (agent.tasks.length > 0) {
    const taskSummary = agent.tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
    compacted += `\n\n## Task List\n${taskSummary}`
  }

  agent.history = [
    ...head,
    { role: "user", content: compacted },
    { role: "assistant", content: "Understood. I'll continue from this summary, re-verifying anything transient." },
    ...tail,
  ]

  // 压缩后回注 task 列表（agent 需要知道自己做到哪了）
  if (agent.tasks.length > 0) {
    const taskSummary = agent.tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
    agent.history.push({
      role: "user",
      content: `[System reminder: your current task list after compaction:\n${taskSummary}\nContinue from where you left off.]`,
    })
  }

  // 重置跟踪计数器（上下文已重建，从头开始计数）
  agent._turnsSinceTaskUpdate = 0
  agent._turnsInPlanMode = 0

  // plan mode 中压缩：重新注入 plan 模式引导
  if (agent.planMode) {
    agent.history.push({
      role: "user",
      content: "[System reminder: plan mode is active. Explore the codebase read-only, design your solution, then call plan with action='exit' to present it for user approval.]",
    })
  }

  return true
}
