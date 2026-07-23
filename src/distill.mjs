/**
 * distill.mjs — 从会话中提取知识候选条目（双轨制的"自动轨"）
 * 原则（已定）：手动触发、LLM 出候选、人工逐条确认后入库。
 * 绝不做会话结束后的全自动沉淀。
 */

import { chat } from "./provider.mjs"
import { put, putMarkdown } from "./memory.mjs"
import { commitAndPush } from "./gitmem.mjs"

const DISTILL_PROMPT = `你是知识提取器。阅读下面的 agent 工作会话记录，提取值得跨会话长期记住的知识。

输出一个 JSON 数组（不要输出任何其他内容）：
[
  {
    "type": "rule | knowledge | decision | pattern",
    "title": "简短标题",
    "content": "完整内容，自包含，脱离会话上下文也能看懂",
    "tags": ["tag1", "tag2"],
    "scope": "personal | project"
  }
]

提取标准：
- knowledge：项目的事实性知识（架构、部署、约定俗成的做法）
- decision：会话中做出的技术决策及理由
- pattern：调试经验、问题解法、可复用的工作模式
- rule：编码规范类（谨慎！规范通常应由人手动撰写，只有会话中明确确立的才提取）
- scope 判断：专属于当前项目的用 project；通用的或个人偏好用 personal

不要提取：
- 一次性的任务细节（"今天改了某个文件的某行"）
- 会话中提到的临时状态（当前的 bug、进行中的工作）
- 客套话和显而易见的事实

如果没有值得提取的内容，输出 []
如果会话太长，优先提取最后出现的、仍在生效的结论。

会话记录：
`

/**
 * 从会话记录提取候选条目。transcript: 纯文本会话记录。
 * 返回 [{ type, title, content, tags, scope }]，解析失败返回 []
 */
export async function extractCandidates(provider, transcript) {
  const res = await chat(provider, {
    messages: [{ role: "user", content: DISTILL_PROMPT + transcript }],
  })
  const match = res.content.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c) => c?.type && c?.title && c?.content)
  } catch {
    return []
  }
}

/**
 * 把 agent 的 OpenAI 格式 history 转成可读的会话记录文本。
 */
export function historyToTranscript(history, { maxChars = 30_000 } = {}) {
  const lines = []
  for (const m of history) {
    if (m.role === "tool") {
      lines.push(`[工具结果] ${(m.content ?? "").slice(0, 500)}`)
    } else if (m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments?.slice(0, 200) ?? ""})`).join(", ")
      lines.push(`[assistant] ${m.content ?? ""}\n[调用工具] ${calls}`)
    } else {
      lines.push(`[${m.role}] ${m.content ?? ""}`)
    }
  }
  const text = lines.join("\n\n")
  // 超长时保留头尾（最早的需求 + 最新的结论最重要）
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return text.slice(0, half) + "\n\n...[中间部分省略]...\n\n" + text.slice(-half)
}

/**
 * 把确认的候选条目写入指定层。
 * opts: { projectDir, team: { dir } | null, author }
 * scope=team 需要 opts.team；project 需要 opts.projectDir。
 * 返回写入结果描述。
 */
export async function saveCandidate(memory, candidate, opts = {}) {
  const scope = candidate.scope ?? "personal"
  const tags = Array.isArray(candidate.tags) ? candidate.tags : (candidate.tags ?? "").split(/\s+/).filter(Boolean)

  if (scope === "personal") {
    const id = await put(memory, { type: candidate.type, title: candidate.title, content: candidate.content, tags: tags.join(" ") })
    return `personal#${id}`
  }
  if (scope === "project") {
    if (!opts.projectDir) throw new Error("project scope unavailable")
    const filename = await putMarkdown(memory, {
      layer: "project", dir: opts.projectDir,
      type: candidate.type, title: candidate.title, content: candidate.content,
      tags, author: opts.author ?? "unknown",
    })
    return `project:${filename}`
  }
  if (scope === "team") {
    if (!opts.team?.dir) throw new Error("team scope not configured")
    const filename = await putMarkdown(memory, {
      layer: "team", dir: opts.team.dir,
      type: candidate.type, title: candidate.title, content: candidate.content,
      tags, author: opts.author ?? "unknown",
    })
    await commitAndPush(opts.team.dir, filename, `memory: [${candidate.type}] ${candidate.title} (distilled)`)
    return `team:${filename}`
  }
  throw new Error(`unknown scope: ${scope}`)
}
