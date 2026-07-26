/**
 * context.mjs — 上下文管理与压缩
 * token 无实测值时用估算兜底（ASCII/4 + 非 ASCII/1，不引 tokenizer 依赖）；
 * 有实测值（响应 usage.prompt_tokens）以实测为准——估算对 CJK 低估 3-4 倍，靠它触发可能永远来不及压缩。
 * 压缩策略：保留最早 2 条 + 最近 N 条，中间由 LLM 摘要成一条（学 kimi-code，简化版）。
 */

import { chat } from "./provider.mjs"

/** 粗估一段文本的 token 数：ASCII 约 4 字符 1 token，CJK 等非 ASCII 约 1 字符 1 token */
function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

/** 粗估一组消息的 token 数（正文 + 思考链 + tool_calls 参数） */
export function estimateTokens(messages) {
  let tokens = 0
  for (const m of messages) {
    if (typeof m.content === "string") tokens += estimateText(m.content)
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") tokens += estimateText(part.text)
        else if (part.type === "image_url") tokens += 256 // 图片占位估算
      }
    }
    if (typeof m.reasoning_content === "string") tokens += estimateText(m.reasoning_content)
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateText(tc.function?.name ?? "") + estimateText(tc.function?.arguments ?? "")
    }
  }
  return tokens
}

const KEEP_HEAD = 2 // 最早的用户意图，不能丢
const KEEP_TAIL = 10 // 最近的工作现场，不能丢

const SUMMARIZE_PROMPT = `你是一个对话压缩器。把下面的 agent 工作记录压缩成一份紧凑的摘要，供后续对话作为上下文使用。
要求：
- 用第一人称、现在时书写——这是"我"的交接笔记，延续自己的思路
- 最重要的：保留设计决策与原因——架构选择、API 约定、命名规范、取舍理由。这是后续代码不能偏离的锚点
- 保留：用户的原始需求、修改过的文件及原因、未解决的问题、下一步计划
- 丢弃：客套话、重复内容、工具输出的细枝末节
- 诚实标注不确定项：没有实际验证过的事必须写"未验证"，不要把猜测写成事实
- 用条目式输出，以信息完整为目标，不要硬卡字数（旧 500 字限制已作废，1M 上下文时代宁长勿缺）

工作记录：
`

/** 压缩后的上下文前缀，告知 agent 发生了什么 */
const COMPACTION_PREFIX =
  "[Context was automatically compacted. Below is a summary of earlier work. " +
  "Treat it as notes, not proof — trust its conclusions (don't redo what it reports as done) " +
  "but re-verify transient state (open files, running processes) with tools before relying on them. " +
  "Design decisions made earlier may be summarized — if you recall a decision that is missing from the summary, check memory_search or re-examine the code.]\n\n"

/** 压缩摘要调用连续失败达到此次数后，降级为确定性截断（丢信息好过任务被 400 打死） */
export const COMPRESS_FAILURE_LIMIT = 3

/** task 回注提醒前缀（压缩后重新注入前，先清掉历史里的旧版本，保持单一信息源） */
const TASK_REINJECT_PREFIX = "[System reminder: your current task list after compaction:"

/** 截断兜底笔记（摘要 LLM 连续失败时用，无 LLM 调用） */
const FALLBACK_NOTE =
  "[Context was truncated after repeated summarization failures. " +
  "The middle portion of earlier work was dropped WITHOUT a summary. " +
  "Re-verify any state you need with tools before relying on it.]\n\n"

/**
 * 切分 head / middle(被摘要) / tail；没有可压缩的中间段返回 null。
 * head 终点必须避开断头 tool_calls：assistant 带了 tool_calls 时其 tool 响应必须留在 head，
 * 否则响应被摘要成纯文本后协议校验 400（tool_calls must be followed by tool messages）。
 * tail 起点必须包含 tool 结果对应的 assistant——tool 在 tail、assistant 在 middle 时，
 * 摘要会把 assistant 吞掉，留下 orphan tool 结果 → 协议 400。
 */
function splitHistory(history) {
  if (history.length <= KEEP_HEAD + KEEP_TAIL + 1) return null
  let headEnd = KEEP_HEAD
  // head 不能以断头 tool_calls 结尾：assistant 声明了 tool_calls，其 tool 结果必须全部留在 head。
  // 并行调用时一个 assistant 后面跟多条 tool 消息——只收一条照样 400，必须一次收完
  if (history[headEnd - 1]?.role === "assistant" && history[headEnd - 1].tool_calls?.length) {
    while (headEnd < history.length && history[headEnd].role === "tool") headEnd++
  }
  let tailStart = history.length - KEEP_TAIL

  // tail 区域内的 tool 消息对应的 assistant tool_calls 若在 middle 里，摘要会把 assistant 吞掉，
  // 剩下 orphan tool 结果 → 协议 400。从 tail 收集 tool_call_id，往前找回所属 assistant 拉进 tail
  const tailToolIds = new Set()
  for (let i = tailStart; i < history.length; i++) {
    if (history[i].role === "tool") tailToolIds.add(history[i].tool_call_id)
  }
  for (let i = tailStart - 1; i > headEnd; i--) {
    const m = history[i]
    if (m.role === "assistant" && m.tool_calls?.some((tc) => tailToolIds.has(tc.id))) {
      tailStart = i
      break
    }
  }

  // skip orphan tool messages at the new tail boundary (tool whose assistant was pulled in above)
  while (tailStart > headEnd && history[tailStart].role === "tool") {
    tailStart++
  }
  if (tailStart <= headEnd) return null
  return { headEnd, tailStart }
}

/** 用一条笔记替换 middle，并回注 task/plan 状态（LLM 摘要与截断兜底共用） */
function applyCompression(agent, headEnd, tailStart, note) {
  const head = agent.history.slice(0, headEnd)
  const tail = agent.history.slice(tailStart)
  agent.history = [
    ...head,
    { role: "user", content: note },
    { role: "assistant", content: "Understood. I'll continue from these notes, re-verifying anything transient." },
    ...tail,
  ]
  // 实测 token 基准随旧历史一起失效（prompt_tokens 对应的是压缩前的上下文），退回估算直到下次响应
  agent._lastPromptTokens = null
  agent._usageAtLen = null

  // 压缩后回注 task 列表（agent 需要知道自己做到哪了）。
  // 单一信息源：先清掉 tail 里残留的旧回注，再注入最新版本——
  // 不再嵌入摘要正文（会与这里重复且逐渐过时）
  agent.history = agent.history.filter(
    (m) => !(m.role === "user" && typeof m.content === "string" && m.content.startsWith(TASK_REINJECT_PREFIX))
  )
  if (agent.tasks.length > 0) {
    const taskSummary = agent.tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
    agent.history.push({
      role: "user",
      content: `${TASK_REINJECT_PREFIX}\n${taskSummary}\nContinue from where you left off.]`,
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
}

/**
 * 如果历史超长则压缩。返回是否发生了压缩。
 * 只在循环的安全点调用（history 末尾是 user 或 tool 消息——完整交换的边界）。
 * 压缩后自动回注 task 列表状态。
 */
export async function compressIfNeeded(agent, threshold) {
  const history = agent.history
  // 真实基准优先：上次响应的 prompt_tokens 是完整上下文（system+tools+history）的实测值，
  // 之后追加的消息用估算补增量；无实测（首轮/恢复后/刚压缩完）退化为纯估算
  const tokens =
    agent._lastPromptTokens != null
      ? agent._lastPromptTokens + estimateTokens(history.slice(agent._usageAtLen ?? history.length))
      : estimateTokens(history)
  if (tokens <= threshold) return false

  const split = splitHistory(history)
  if (!split) {
    // 历史太短（≤13 条）切不出中间段，但 token 已超阈值——典型是一条巨型消息
    // （大段粘贴/超大注入）。摘要无路可走时退化为确定性瘦身，保证上下文总能减下去
    return shrinkOversized(agent)
  }

  const middle = history.slice(split.headEnd, split.tailStart)
  const serialized = middle
    .map((m) => {
      const toolNote = m.tool_calls ? ` [调用了工具: ${m.tool_calls.map((t) => t.function.name).join(", ")}]` : ""
      // user 消息放宽到 8000：用户粘贴的长需求被切掉会让摘要丢失原始意图；tool/assistant 2000 足够
      const cap = m.role === "user" ? 8000 : 2000
      const content = typeof m.content === "string" ? m.content.slice(0, cap) : ""
      return `[${m.role}]${toolNote} ${content}`
    })
    .join("\n")

  const summary = await chat(agent.provider, {
    messages: [{ role: "user", content: SUMMARIZE_PROMPT + serialized }],
  })

  applyCompression(agent, split.headEnd, split.tailStart, COMPACTION_PREFIX + summary.content)
  return true
}

/**
 * 确定性截断兜底：摘要 LLM 连续失败时调用，不碰网络。
 * 丢掉 middle 换任务能继续跑。返回是否发生了截断。
 */
export function compressFallback(agent) {
  const split = splitHistory(agent.history)
  if (!split) return false
  applyCompression(agent, split.headEnd, split.tailStart, FALLBACK_NOTE)
  return true
}

/** 单条消息正文的硬截断长度：超过且在压缩无法切分时截断换桩（防一条巨消息卡死压缩） */
const OVERSIZE_CONTENT_LIMIT = 8_000

/**
 * 确定性瘦身：splitHistory 切不出中间段（历史太短）但已超阈值时的最后手段，无 LLM 调用。
 * 把超过 OVERSIZE_CONTENT_LIMIT 的 user/tool 正文截断换桩（保留首尾）；
 * 不动 reasoning_content（DeepSeek/Kimi 回传协议）与 tool_calls 配对结构，无协议 400 风险。
 * 只在 compressIfNeeded 判定超阈值后调用。返回是否有消息被截断。
 */
export function shrinkOversized(agent) {
  let shrunk = false
  for (const m of agent.history) {
    if ((m.role !== "user" && m.role !== "tool") || typeof m.content !== "string") continue
    if (m.content.length <= OVERSIZE_CONTENT_LIMIT) continue
    m.content =
      m.content.slice(0, 4_000) +
      `\n[... ${m.content.length - 6_000} chars truncated — single message too large for context window ...]\n` +
      m.content.slice(-2_000)
    shrunk = true
  }
  if (shrunk) {
    // 与压缩同理：实测 token 基准随被改动的历史失效，退回估算直到下次响应
    agent._lastPromptTokens = null
    agent._usageAtLen = null
  }
  return shrunk
}
