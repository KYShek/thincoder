/**
 * agent.mjs — Agent 主循环
 * LLM ↔ 工具调用循环，直到任务完成。
 * 工具执行用两段式：权限确认串行，只读工具并行、有副作用工具串行。
 */

import { chat } from "./provider.mjs"
import { compressIfNeeded } from "./context.mjs"
import { search as memorySearch } from "./memory.mjs"
import { toOpenAISchema } from "./tools.mjs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const DEFAULT_MAX_TURNS = 50

const VALID_TASK_STATUS = new Set(["pending", "in_progress", "done"])

/**
 * task 工具：多步任务规划与进度跟踪（Claude Code 的 todo 模式）。
 * 每次调用整体替换列表；只改 agent 内部状态、不碰外部世界，故 readonly。
 * 通过 ctx.agent 访问调用方 agent（由 runAgent 注入）。
 * 注：ctx.agent 的回写是有意的轻量耦合——task 本质是主循环的内建能力而非普通工具，
 * 伪装成工具是为了让 LLM 用统一的 tool calling 协议调用它；替代方案（主循环特判）
 * 会让循环代码更绕，不值。
 */
export const taskTool = {
  name: "task",  description:
    "Plan and track a task list for complex multi-step work. Replaces the entire list on each call. Use for requests needing 3+ steps: break work into items, keep exactly one in_progress, mark done as you complete each. Statuses: pending | in_progress | done.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["items"],
  },
  readonly: true,
  async execute(args, ctx) {
    const items = (args.items ?? []).map((it) => ({
      title: String(it.title ?? "").slice(0, 200),
      status: VALID_TASK_STATUS.has(it.status) ? it.status : "pending",
    }))
    ctx.agent.tasks = items
    ctx.agent._onTaskUpdate?.(items)
    const done = items.filter((i) => i.status === "done").length
    return `Task list updated: ${done}/${items.length} done`
  },
}

/** 项目指令文件候选（按优先级拼接所有存在的） */
const INSTRUCTION_FILES = ["AGENTS.md", "agents.md", "PROJECT_RULES.md", "project_rules.md", ".thincoder/rules.md"]
const MAX_INSTRUCTION_CHARS = 8000

/** 读取项目指令（AGENTS.md / project_rules 等），没有则返回空串 */
export async function loadProjectInstructions(cwd) {
  const parts = []
  for (const name of INSTRUCTION_FILES) {
    try {
      const text = await readFile(join(cwd, name), "utf8")
      if (text.trim()) parts.push(`# ${name}\n${text.trim()}`)
    } catch {
      // 文件不存在，跳过
    }
    if (parts.join("\n").length > MAX_INSTRUCTION_CHARS) break
  }
  return parts.join("\n\n").slice(0, MAX_INSTRUCTION_CHARS)
}

const SYSTEM_PROMPT = `You are ThinCoder, a coding agent. Thin means sharp: you are a terse, precise engineer who cuts straight to the point—no fluff, no showing off, no filler. You write the most minimal, elegant code that solves the problem, and you say things in as few words as the truth allows.

Rules:
- Prefer tool calls over guessing. Read files before modifying them.
- When you need multiple independent pieces of information (e.g. reading several files), make all independent tool calls in the SAME response so they can run in parallel.
- Be concise in your final answers. Report what you did, not what you plan to do.
- If the request is ambiguous at a decision that matters, stop and ask in your reply instead of guessing—but ask at most once, then proceed with the most reasonable interpretation.
- For complex multi-step requests (3+ steps), use the task tool to plan and track progress; keep exactly one item in_progress.
- Never fabricate file contents or command outputs; only trust tool results.
- You have long-term memory via memory_put/memory_search. When you learn a durable fact about this project (convention, decision, debugging insight), save it with memory_put. Relevant memories may be injected below—use them.`

/**
 * 创建 agent。
 * { provider, tools, config, cwd, memory? } —— memory 可空（无记忆模式）
 */
export function createAgent({ provider, tools, config, cwd, memory = null }) {
  return {
    provider,
    tools,
    config,
    cwd,
    memory,
    history: [], // OpenAI 格式的对话历史（不含 system）
    tasks: [], // task 工具维护的任务列表
  }
}

/**
 * 跑一轮任务。
 * callbacks: {
 *   onToken(text), onReasoning(text),
 *   onToolCall(name, args), onToolResult(name, result),
 *   onPermissionRequest(name, args) => Promise<boolean>  // 有副作用工具调用前询问；不提供则默认拒绝
 * }
 * 返回最终文本。
 */
export async function runAgent(agent, input, callbacks = {}) {
  const maxTurns = agent.config?.agent?.maxTurns ?? DEFAULT_MAX_TURNS
  const threshold = agent.config?.agent?.compactThreshold ?? 100_000
  agent.history.push({ role: "user", content: input })

  // task 工具随主循环注入（不在 agent.tools 里，它是循环的内建能力）
  const tools = [...agent.tools, taskTool]
  const toolSchemas = tools.map(toOpenAISchema)
  const toolByName = new Map(tools.map((t) => [t.name, t]))
  agent._onTaskUpdate = callbacks.onTaskUpdate

  // 记忆注入：按用户输入检索相关记忆，附加到 system prompt
  let systemPrompt = SYSTEM_PROMPT
  const projectRules = await loadProjectInstructions(agent.cwd)
  if (projectRules) {
    systemPrompt += `\n\nProject instructions (follow these as project conventions):\n${projectRules}`
  }
  if (agent.memory) {
    const memories = await memorySearch(agent.memory, input, { limit: 3 })
    if (memories.length > 0) {
      systemPrompt +=
        "\n\nRelevant memories from previous sessions:\n" +
        memories.map((m) => `- [${m.type}] ${m.title}: ${m.content}`).join("\n")
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    // 每轮 LLM 调用前检查上下文长度，超阈值先压缩（末尾是 user 或 tool 消息都是安全点；
    // 但压缩只在末尾是 user 时最干净，tool 结尾说明在工具循环中段，下一轮再压）
    if (agent.history.at(-1)?.role === "user") {
      if (await compressIfNeeded(agent, threshold)) {
        callbacks.onCompress?.()
      }
    }

    const messages = [{ role: "system", content: systemPrompt }, ...agent.history]

    const response = await chat(agent.provider, {
      messages,
      tools: toolSchemas,
      onToken: callbacks.onToken,
      onReasoning: callbacks.onReasoning,
    })

    // 无工具调用：最终回答，收尾
    if (response.toolCalls.length === 0) {
      agent.history.push({ role: "assistant", content: response.content })
      return response.content
    }

    // 有工具调用：assistant 消息（含 tool_calls）入历史
    agent.history.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    const results = await executeToolCalls(agent, toolByName, response.toolCalls, callbacks)

    // 结果按 toolCallId 配对回喂（协议按 ID 不按位置，完成乱序无影响）
    for (const { toolCall, result } of results) {
      agent.history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      })
    }
  }

  throw new Error(`Agent exceeded max turns (${maxTurns})`)
}

/**
 * 两段式执行：
 * 阶段一（串行）：逐个解析参数 + 权限确认（有副作用工具）
 * 阶段二（分类）：只读工具 Promise.all 并行；有副作用工具逐个串行
 * 返回按 toolCallId 配对的结果数组。
 */
async function executeToolCalls(agent, toolByName, toolCalls, callbacks) {
  // ---- 阶段一：串行准备 ----
  const prepared = []
  for (const toolCall of toolCalls) {
    const tool = toolByName.get(toolCall.name)
    let args = {}
    try {
      args = JSON.parse(toolCall.arguments || "{}")
    } catch {
      prepared.push({ toolCall, tool: null, error: `Invalid tool arguments JSON: ${toolCall.arguments}` })
      continue
    }

    if (!tool) {
      prepared.push({ toolCall, tool: null, error: `Unknown tool: ${toolCall.name}` })
      continue
    }

    if (!tool.readonly) {
      const allowed = callbacks.onPermissionRequest
        ? await callbacks.onPermissionRequest(toolCall.name, args)
        : false
      if (!allowed) {
        prepared.push({ toolCall, tool, denied: true })
        continue
      }
    }

    callbacks.onToolCall?.(toolCall.name, args)
    prepared.push({ toolCall, tool, args })
  }

  // ---- 阶段二：分类执行 ----
  const runOne = async (item) => {
    if (item.error) return { ...item, result: `Error: ${item.error}` }
    if (item.denied) return { ...item, result: "Error: permission denied by user" }
    try {
      const result = await item.tool.execute(item.args, { cwd: agent.cwd, agent })
      callbacks.onToolResult?.(item.toolCall.name, result)
      return { ...item, result: String(result) }
    } catch (error) {
      return { ...item, result: `Error: ${error.message}` }
    }
  }

  const readonlyItems = prepared.filter((p) => p.tool?.readonly)
  const sideEffectItems = prepared.filter((p) => !p.tool?.readonly)

  // 只读工具并行
  const readonlyResults = await Promise.all(readonlyItems.map(runOne))
  // 有副作用工具串行
  const sideEffectResults = []
  for (const item of sideEffectItems) {
    sideEffectResults.push(await runOne(item))
  }

  // 按原始 toolCall 顺序合并（保持历史可读性；协议层靠 ID 配对，顺序无关正确性）
  const resultByCallId = new Map()
  for (const r of [...readonlyResults, ...sideEffectResults]) {
    resultByCallId.set(r.toolCall.id, r)
  }
  return toolCalls.map((tc) => resultByCallId.get(tc.id))
}
