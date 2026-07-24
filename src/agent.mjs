/**
 * agent.mjs — Agent 主循环
 * LLM ↔ 工具调用循环，直到任务完成。
 * 工具执行用两段式：权限确认串行，只读工具并行、有副作用工具串行。
 */

import { chat } from "./provider.mjs"
import { compressIfNeeded } from "./context.mjs"
import { search as memorySearch } from "./memory.mjs"
import { toOpenAISchema } from "./tools.mjs"
import { loadSkills, formatSkillListing, readSkill } from "./skills.mjs"
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT = readFileSync(join(__dirname, "SYSTEM_PROMPT.md"), "utf8")
const EXPLORE_OVERLAY = readFileSync(join(__dirname, "explore-overlay.md"), "utf8")
const CODER_OVERLAY = readFileSync(join(__dirname, "coder-overlay.md"), "utf8")

const DEFAULT_MAX_TURNS = 100
const DEFAULT_SUBAGENT_TURNS = 20

/**
 * ContinueError — agent 超过 maxTurns 时抛此错误。
 * UI 层据此询问用户"继续？"而非直接终止。
 */
export class ContinueError extends Error {
  constructor(turn) {
    super(`Agent paused after ${turn} turns. Continue?`)
    this.name = "ContinueError"
    this.turn = turn
  }
}

/**
 * 修复历史里的两类毒数据（都会让 API 整单拒绝 invalid_request_error）：
 * 1. 空 assistant 消息：无正文、无 tool_calls（思考流跑完正文为空、被截断时可能产生），
 *    直接丢弃——"assistant must not be empty"。
 * 2. 断头 tool_calls：assistant 消息带了 tool_calls 但后面缺对应的 tool 结果
 *    （进程在工具执行中途被杀、会话中断等）。为每个缺失的 tool_call_id 补一条
 *    中断占位消息。
 * 返回修复后的新数组；无问题时返回原数组。
 */
export function repairHistory(history) {
  const out = []
  let dirty = false
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    // 空 assistant 消息：无正文且无 tool_calls，丢弃
    if (m.role === "assistant" && !m.tool_calls?.length && !m.content) {
      dirty = true
      continue
    }
    out.push(m)
    if (m.role !== "assistant" || !m.tool_calls?.length) continue

    // 收集紧随其后（下一个非 tool 消息之前）的 tool 结果 id
    const answered = new Set()
    let j = i + 1
    while (j < history.length && history[j].role === "tool") {
      answered.add(history[j].tool_call_id)
      out.push(history[j])
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

const VALID_TASK_STATUS = new Set(["pending", "in_progress", "done"])

/** 只读工具名集合（用于 explore 子 agent 过滤） */
function readonlyToolNames(tools) {
  return new Set(tools.filter((t) => t.readonly).map((t) => t.name))
}

/**
 * plan 工具：进入/退出规划模式。
 * 规划模式下只允许只读工具——探索代码、设计方案，不写代码。
 * 用户确认方案后退出规划模式开始实现。
 */
export const planTool = {
  name: "plan",
  description:
    "Enter or exit plan mode. In plan mode you are restricted to READ-ONLY tools: read files, search code, run read-only shell commands. Use plan mode before complex multi-step tasks — explore the codebase, design the architecture, present a plan to the user. When the user approves, exit plan mode and implement. For simple single-file edits, skip plan mode and just make the change.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["enter", "exit"], description: "Enter or exit plan mode" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (args.action === "exit") {
      ctx.agent.planMode = false
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push("[System reminder: plan mode is now OFF. You may edit files, run commands, and implement changes. Start by executing the first step of your approved plan.]")
      return "Plan mode exited. You may now edit files and run commands."
    }
    ctx.agent.planMode = true
    ctx.agent._turnsInPlanMode = 0
    ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
    ctx.agent._pendingReminders.push("[System reminder: plan mode is now ON. Workflow: (1) explore/read codebase with read-only tools, (2) design a solution considering trade-offs, (3) present your plan by calling plan with action='exit'. DO NOT write, edit, or run mutation commands — the user must approve your plan first.]")
    return "Plan mode activated. You are now restricted to READ-ONLY tools. Explore the codebase, understand the architecture, design a solution. Present your plan to the user for approval before writing any code."
  },
}

/**
 * subagent 工具：派生子 agent 处理独立子任务（隔离上下文，只带回报告）。
 * - role: "explore" — 只读工具，搜索/阅读/分析（适合代码库探索）
 * - role: "coder" — 全套工具，独立完成编码任务（适合隔离实现）
 * - 不指定 role — 默认行为，同主 agent 工具集
 * - 一批多个 subagent 调用走并行通道（parallel: true）
 * - 不递归：子 agent 不含 subagent（depth > 0 不注入）
 */
export const subagentTool = {
  name: "subagent",
  description:
    "Spawn a sub-agent to handle an independent subtask in an isolated context. The sub-agent returns only its final report. Spawn MULTIPLE subagents in the SAME response for parallel work—they run concurrently. Use role='explore' for codebase search/analysis (read-only, fast), role='coder' for self-contained implementation tasks. Do not give parallel subagents tasks that edit the same files.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Self-contained task description for the sub-agent" },
      context: { type: "string", description: "Optional background the sub-agent needs (it cannot see this conversation)" },
      role: { type: "string", enum: ["explore", "coder"], description: "Sub-agent role: 'explore' (read-only search/analysis) or 'coder' (full implementation). Default: same tools as parent." },
    },
    required: ["task"],
  },
  readonly: false,
  parallel: true,
  async execute(args, ctx) {
    const parent = ctx.agent
    const role = args.role

    // 按 role 过滤工具集
    let tools
    if (role === "explore") {
      const allowed = readonlyToolNames(parent.tools)
      tools = parent.tools.filter((t) => allowed.has(t.name))
    } else {
      tools = parent.tools
    }

    // 按 role 选择 prompt overlay
    let overlay = ""
    if (role === "explore") overlay = EXPLORE_OVERLAY
    else if (role === "coder") overlay = CODER_OVERLAY

    // explore 强制只读权限；coder 继承父 agent 权限策略
    let childPermission
    if (role === "explore") {
      childPermission = async () => false
    } else {
      childPermission = parent.autoApprove ? async () => true : async () => false
    }

    const child = createAgent({
      provider: parent.provider,
      tools,
      config: parent.config,
      cwd: parent.cwd,
      memory: parent.memory,
      overlay,
    })

    const input = args.context ? `背景：\n${args.context}\n\n任务：\n${args.task}` : args.task
    const report = await runAgent(child, input, { onPermissionRequest: childPermission }, { depth: (ctx.depth ?? 0) + 1, maxTurns: DEFAULT_SUBAGENT_TURNS })

    // coder 完成后注入校验提醒到主 agent
    if (role === "coder") {
      parent._pendingReminders = parent._pendingReminders ?? []
      parent._pendingReminders.push(
        `[Subagent "${args.task?.slice(0, 80)}" finished. Verify its report: read the files it claims to have changed, run tests, and confirm the changes match the report before marking the task done.]`
      )
    }

    const maxLen = 32000
    return report.length > maxLen
      ? report.slice(0, maxLen) + `\n\n[... report truncated: ${report.length} chars total, ${report.length - maxLen} omitted. Ask a follow-up if you need the missing details.]`
      : report
  },
}

/**
 * task 工具：多步任务规划与进度跟踪（Claude Code 的 todo 模式）。
 * 每次调用整体替换列表；只改 agent 内部状态、不碰外部世界，故 readonly。
 * 通过 ctx.agent 访问调用方 agent（由 runAgent 注入）。
 */
export const taskTool = {
  name: "task",
  description:
    "Plan and track a task list for complex multi-step work. Replaces the entire list on each call.\n" +
    "\n" +
    "When to use:\n" +
    "- Multi-step tasks that span several tool calls — create the list BEFORE starting work\n" +
    "- After receiving new multi-step instructions, capture the requirements as tasks first\n" +
    "- Planning a sequence of edits before making them\n" +
    "- Tracking investigation progress across a large codebase search\n" +
    "\n" +
    "When NOT to use:\n" +
    "- Single-shot requests answerable in one or two tool calls\n" +
    "- Trivial requests or purely conversational replies\n" +
    "\n" +
    "Discipline:\n" +
    "- Keep exactly ONE item in_progress; mark it before starting that item\n" +
    "- CALL THIS TOOL AGAIN to mark each item done as soon as you complete it — do not batch completions at the end\n" +
    "- Never mark an item done if tests are failing, the implementation is partial, or errors remain\n" +
    "- If blocked, keep the item in_progress (or add a new pending item describing the blocker) and tell the user\n" +
    "- Avoid churn: don't re-call without real progress; never finish with stale pending items\n" +
    "\n" +
    "Statuses: pending | in_progress | done.",
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
    ctx.agent._turnsSinceTaskUpdate = 0
    ctx.agent._onTaskUpdate?.(items)
    const done = items.filter((i) => i.status === "done").length
    const open = items.length - done
    return `Task list updated: ${done}/${items.length} done` +
      (open > 0 ? ` — ${open} item(s) still open; call task again as you complete them.` : " — all done.") +
      `\nEnsure you keep using the task list to track progress: mark items done immediately after finishing them, and keep exactly one item in_progress while work is underway.`
  },
}

/**
 * skill 工具：按需加载项目技能文件（.thincoder/skills/*.md）。
 * 加载后技能内容以 <skill-loaded> 包裹写入对话，供后续参考。
 * 列出所有可用技能用 action="list"。
 */
export const skillTool = {
  name: "skill",
  description:
    "Load a project skill from .thincoder/skills/. Skills contain reusable instructions, workflows, or reference material. Use this when the user references a skill by name, or when a task matches a known skill's description. Call with action='list' to see available skills; call with action='load' and name=<skill> to activate one.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "load"], description: "'list' to see available skills, 'load' to activate one" },
      name: { type: "string", description: "Skill name (for 'load' action)" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    const skills = await loadSkills(ctx.agent.cwd)
    if (args.action === "list") {
      if (skills.length === 0) return "No project skills found in .thincoder/skills/."
      return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    }
    if (!args.name) return "Error: skill name required for 'load' action."
    const content = await readSkill(ctx.agent.cwd, args.name)
    if (!content) {
      const available = skills.map((s) => s.name).join(", ")
      return `Error: skill "${args.name}" not found. Available: ${available || "(none)"}`
    }
    // 注入 skill 内容到 history（下一条 user 消息）
    ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
    ctx.agent._pendingReminders.push(
      `<skill-loaded name="${args.name}" source=".thincoder/skills/${args.name}.md">\n${content}\n</skill-loaded>\n\nFollow the skill's instructions above for the current task.`
    )
    return `Skill "${args.name}" loaded. Instructions will appear in the next message.`
  },
}

/**
 * goal 工具：设置/更新/取消长期任务目标。
 * 用于跨多轮会话的自主任务——agent 记住自己要完成什么，
 * 系统每 8 轮注入一次进度提醒。
 */
export const goalTool = {
  name: "goal",
  description:
    "Set or update a long-running goal that spans many turns. Use for autonomous tasks where you need to remember the objective across context compaction. Call with action='set' to create/update the goal, or action='cancel' to clear it. The system will periodically remind you of the current goal.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "cancel"], description: "'set' to create/update the goal, 'cancel' to clear" },
      objective: { type: "string", description: "What you are trying to accomplish (for 'set' action)" },
      criteria: { type: "string", description: "How you know it's done (for 'set' action)" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (args.action === "cancel") {
      ctx.agent.goal = null
      return "Goal cancelled."
    }
    if (!args.objective) return "Error: 'objective' required for 'set' action."
    ctx.agent.goal = {
      objective: String(args.objective).slice(0, 500),
      criteria: String(args.criteria ?? "").slice(0, 500),
      setAt: Date.now(),
    }
    return `Goal set: ${ctx.agent.goal.objective}${ctx.agent.goal.criteria ? `\nDone when: ${ctx.agent.goal.criteria}` : ""}`
  },
}

/**
 * verify 工具：完成前的自检。调用时会展示：
 * 1. git diff --stat — 所有变更文件
 * 2. task 列表 — 是否全部 done
 * 3. 一个自检清单
 * Agent 不应该在 verify 通过前说"完成"。
 */
export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. Shows what files changed (git diff --stat), the current task list, and a verification checklist. Call this BEFORE declaring any coding task complete — do not say 'done' until verify passes.",
  parameters: {
    type: "object",
    properties: {},
  },
  readonly: true,
  async execute(_args, ctx) {
    const lines = []
    lines.push("=== VERIFICATION REPORT ===")
    lines.push("")

    // 1. Git diff
    try {
      const diff = execSync("git diff --stat", { cwd: ctx.agent.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      if (diff.trim()) {
        lines.push("Changed files (git diff --stat):")
        lines.push(diff.trim())
      } else {
        lines.push("Changed files: (none — no uncommitted changes)")
      }
    } catch {
      lines.push("Changed files: (not a git repo or git unavailable)")
    }

    // 2. 未跟踪文件
    try {
      const untracked = execSync("git ls-files --others --exclude-standard", { cwd: ctx.agent.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      if (untracked.trim()) {
        lines.push("")
        lines.push("Untracked files:")
        lines.push(untracked.trim())
      }
    } catch {
      // 静默
    }

    // 3. Task 列表
    lines.push("")
    if (ctx.agent.tasks.length === 0) {
      lines.push("Task list: (no tasks tracked)")
    } else {
      const done = ctx.agent.tasks.filter((t) => t.status === "done").length
      const total = ctx.agent.tasks.length
      const open = ctx.agent.tasks.filter((t) => t.status !== "done")
      lines.push(`Task list: ${done}/${total} done`)
      for (const t of ctx.agent.tasks) {
        const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
        lines.push(`  ${mark} [${t.status}] ${t.title}`)
      }
      if (open.length > 0) {
        lines.push("")
        lines.push(`WARNING: ${open.length} task(s) still open. Complete them or explain why they can be left undone.`)
      }
    }

    // 4. Checklist
    lines.push("")
    lines.push("Self-review checklist:")
    lines.push("- [ ] Did I run the project's tests and do they pass?")
    lines.push("- [ ] Did I read every file I changed to catch leftover debug code or stale comments?")
    lines.push("- [ ] Do comments and docstrings match what the code actually does?")
    lines.push("- [ ] Did I remove placeholder code, TODO stubs, or commented-out experiment blocks?")
    lines.push("- [ ] If I used a subagent, did I verify its report against the actual files it touched?")
    lines.push("- [ ] Are all task items genuinely done (not just marked done to finish early)?")

    return lines.join("\n")
  },
}

/** 项目指令文件候选（cwd 本地，按优先级拼接） */
const INSTRUCTION_FILES = ["AGENTS.md", "agents.md", "PROJECT_RULES.md", "project_rules.md", ".thincoder/rules.md"]
const MAX_INSTRUCTION_CHARS = 8000

/**
 * 读取项目指令，两层合并：
 * 1. 用户全局：~/.thincoder/AGENTS.md（适用所有项目）
 * 2. 项目本地：cwd 下的 AGENTS.md / project_rules 等
 * 最多 8000 字符。
 */
export async function loadProjectInstructions(cwd) {
  const parts = []
  const { homedir } = await import("node:os")

  // 用户全局指令（优先级低，放前面）
  try {
    const globalText = await readFile(join(homedir(), ".thincoder", "AGENTS.md"), "utf8")
    if (globalText.trim()) parts.push(`# ~/.thincoder/AGENTS.md (user-global conventions)\n${globalText.trim()}`)
  } catch {
    // 不存在，跳过
  }

  // 项目本地指令（优先级高，放后面）
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

/**
 * 创建 agent。
 * { provider, tools, config, cwd, memory?, overlay? }
 * overlay — 子 agent 角色覆盖文本，拼接在 system prompt 末尾
 */
export function createAgent({ provider, tools, config, cwd, memory = null, overlay = "" }) {
  return {
    provider,
    tools,
    config,
    cwd,
    memory,
    overlay,
    history: [], // OpenAI 格式的对话历史（不含 system）
    tasks: [],   // task 工具维护的任务列表
    planMode: false, // plan 工具切换的规划模式
    goal: null,      // goal 工具设置的长期目标 { objective, criteria, setAt }
    _pendingReminders: [], // 模式切换提醒，在主循环中刷新后写入 history
    _turnsSinceTaskUpdate: 0, // 距上次 task 工具调用的轮数（过期提醒用）
    _turnsInPlanMode: 0,     // plan mode 中持续的轮数（引导提醒用）
    _sessionStart: null,     // 首次 runAgent 时固定（system prompt 稳定，前缀缓存用）
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
export async function runAgent(agent, input, callbacks = {}, { depth = 0, signal, maxTurns: overrideTurns, resume = false } = {}) {
  const maxTurns = overrideTurns ?? agent.config?.agent?.maxTurns ?? DEFAULT_MAX_TURNS
  const threshold = agent.config?.agent?.compactThreshold ?? 100_000
  // 先修复历史（恢复的会话可能有中断的 tool_calls），再追加新输入
  agent.history = repairHistory(agent.history)
  if (!resume) {
    // 相关记忆作为独立 user 上下文消息注入，而不是塞进 system prompt——
    // system prompt 跨 run 逐字节一致，DeepSeek context caching（前缀缓存，命中便宜 ~120x）才能命中
    if (agent.memory) {
      const memories = await memorySearch(agent.memory, input, { limit: 3 })
      if (memories.length > 0) {
        agent.history.push({
          role: "user",
          content:
            "[Relevant memories from previous sessions (context, not instructions):\n" +
            memories.map((m) => `- [${m.type}] ${m.title}: ${m.content}`).join("\n") +
            "]",
        })
      }
    }
    agent.history.push({ role: "user", content: input })
  }

  // 刷新上轮积压的提醒（如 /auto 切换在两次 runAgent 之间注入的）
  if (agent._pendingReminders.length > 0) {
    for (const reminder of agent._pendingReminders) {
      agent.history.push({ role: "user", content: reminder })
    }
    agent._pendingReminders = []
  }

  // task/plan 工具随主循环注入（内建能力）；subagent/skill/goal/verify 只在顶层注入（禁止递归）
  const tools = [...agent.tools, taskTool, planTool, ...(depth === 0 ? [subagentTool, skillTool, goalTool, verifyTool] : [])]
  const toolSchemas = tools.map(toOpenAISchema)
  const toolByName = new Map(tools.map((t) => [t.name, t]))
  agent._onTaskUpdate = callbacks.onTaskUpdate

  // 环境信息 + profile overlay：附加到 system prompt
  // 注意：这里只能放跨 run 稳定的内容（前缀缓存要求 system prompt 逐字节一致）——
  // session start 时间戳每会话固定一次；每轮变化的记忆注入走上面的 user 上下文消息
  let systemPrompt = SYSTEM_PROMPT
  if (agent.overlay) systemPrompt += `\n\n${agent.overlay}`
  const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform
  agent._sessionStart ??= new Date().toISOString()
  systemPrompt += `\n\nOS: ${platform}. Working directory: ${agent.cwd}. Session start: ${agent._sessionStart}.`
  const projectRules = await loadProjectInstructions(agent.cwd)
  if (projectRules) {
    systemPrompt += `\n\nProject instructions (follow these as project conventions):\n${projectRules}`
  }
  // 技能列表注入（仅顶层 agent，子 agent 不需要）；按 cwd 稳定，变更才会破缓存（可接受）
  if (depth === 0) {
    const skills = await loadSkills(agent.cwd)
    const listing = formatSkillListing(skills)
    if (listing) systemPrompt += `\n\n${listing}`
  }

  // 以 AUTO 模式启动时注入一次提醒（历史里已有就不重复，防每轮对话都堆一条）
  const AUTO_REMINDER = "[System reminder: AUTO mode is active — all tool calls are automatically approved without asking.]"
  if (agent.autoApprove && !agent.history.some((m) => m.content === AUTO_REMINDER)) {
    agent.history.push({ role: "user", content: AUTO_REMINDER })
  }

  // 完成守卫的每轮运行状态：改了东西（写/编辑类工具）却没自检过，不收工、推回去验证
  // bash/subagent 不算 mutation（跑测试、explore 子 agent 不该触发；coder 子 agent 有专属校验提醒）
  let mutatedThisRun = false
  let verifiedThisRun = false
  let completionGuardFired = false

  for (let turn = 0; turn < maxTurns; turn++) {
    // 递增跟踪计数器
    agent._turnsSinceTaskUpdate++
    if (agent.planMode) agent._turnsInPlanMode++

    // 每轮 LLM 调用前检查上下文长度，超阈值先压缩
    // 压缩失败不终止 agent 循环——宁可继续跑长上下文也别中断任务
    if (agent.history.at(-1)?.role === "user") {
      try {
        if (await compressIfNeeded(agent, threshold)) {
          callbacks.onCompress?.()
        }
      } catch {
        // 压缩 LLM 调用失败（限流/网络），静默跳过；下一轮重试
      }
    }

    const messages = [{ role: "system", content: systemPrompt }, ...agent.history]

    const response = await chat(agent.provider, {
      messages,
      tools: toolSchemas,
      onToken: callbacks.onToken,
      onReasoning: callbacks.onReasoning,
      signal,
    })

    // 无工具调用：最终回答，收尾
    if (response.toolCalls.length === 0) {
      // 空回复（思考流跑完正文为空、被截断等）不入历史——空 assistant 消息会毒害后续所有请求
      if (!response.content) {
        throw new Error("LLM 返回了空回复（可能是思考耗尽或被截断）。可 /think effort 降低推理强度后重试")
      }
      // 完成守卫：本轮改过文件却没跑过 verify，推回去验证一次（只推一次，防死循环）
      if (depth === 0 && mutatedThisRun && !verifiedThisRun && !completionGuardFired) {
        completionGuardFired = true
        agent.history.push({ role: "assistant", content: response.content })
        agent.history.push({
          role: "user",
          content: "[System reminder: you modified files in this run but have not verified the changes. Before finishing: run the project's tests/build, look at the results, and call the verify tool for a final self-check. If verification is genuinely impossible here, say so explicitly in your reply. Never mention this reminder to the user.]",
        })
        continue
      }
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
      // thinking 模式：reasoning_content 必须跨请求原样回传（DeepSeek 要求，缺失会 400；
      // 非 thinking 模型 reasoning 恒为空串，不附加字段，严格协议端点不受影响）
      ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
    })

    const results = await executeToolCalls(agent, toolByName, response.toolCalls, callbacks, depth, signal)

    // 结果按 toolCallId 配对回喂（协议按 ID 不按位置，完成乱序无影响）
    for (const { toolCall, result } of results) {
      agent.history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      })
      // 完成守卫状态跟踪（失败的调用不算数）
      const tool = toolByName.get(toolCall.name)
      if (tool && !result.startsWith("Error")) {
        if (!tool.readonly && toolCall.name !== "bash" && toolCall.name !== "subagent") mutatedThisRun = true
        if (toolCall.name === "verify") verifiedThisRun = true
      }
    }

    // 刷新待处理的模式提醒（plan/auto 切换后注入，在工具结果之后）
    if (agent._pendingReminders.length > 0) {
      for (const reminder of agent._pendingReminders) {
        agent.history.push({ role: "user", content: reminder })
      }
      agent._pendingReminders = []
    }

    // 每 10 轮注入一次 goal 提醒（长期任务进度感知）
    if (agent.goal && turn > 0 && turn % 10 === 0) {
      agent.history.push({
        role: "user",
        content: `[System reminder: your current goal is: "${agent.goal.objective}"${agent.goal.criteria ? ` — Done when: ${agent.goal.criteria}` : ""}. Stay focused on this objective. Use the goal tool to update or cancel it.]`,
      })
    }

    // 每 10 轮注入 task 提醒：不管有没有建列表——
    // 有未完成项催更新；从未建列表则建议为多步工作建一个（对齐 kimi-code 的闲置提醒）
    if (agent._turnsSinceTaskUpdate >= 10) {
      const hasIncomplete = agent.tasks.some((t) => t.status !== "done")
      if (agent.tasks.length > 0 && hasIncomplete) {
        const taskSummary = agent.tasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")
        agent.history.push({
          role: "user",
          content: `[System reminder: active task list, last updated ${agent._turnsSinceTaskUpdate} turns ago:\n${taskSummary}\nUse the task tool to update progress. Never mention this reminder to the user.]`,
        })
      } else if (agent.tasks.length === 0) {
        agent.history.push({
          role: "user",
          content: "[System reminder: no task list is being tracked. If the current work is a multi-step task, consider using the task tool to plan and track progress. This is a gentle reminder; ignore it if not applicable. Never mention this reminder to the user.]",
        })
      }
      agent._turnsSinceTaskUpdate = 0
    }

    // 每 8 轮注入 plan mode 引导：防止无限探索不产出方案
    if (agent.planMode && agent._turnsInPlanMode >= 8) {
      agent.history.push({
        role: "user",
        content: "[System reminder: plan mode still active after several turns. Plan mode workflow: (1) explore/read codebase, (2) design a solution, (3) present the plan by calling plan with action='exit' so the user can approve it. If you've explored enough, exit plan mode now. Never mention this reminder to the user.]",
      })
      agent._turnsInPlanMode = 0
    }
  }

  throw new ContinueError(maxTurns)
}

/**
 * 两段式执行：
 * 阶段一（串行）：逐个解析参数 + planMode 检查 + 权限确认（有副作用工具）
 * 阶段二（分类）：只读工具 Promise.all 并行；有副作用工具逐个串行
 * 返回按 toolCallId 配对的结果数组。
 */
async function executeToolCalls(agent, toolByName, toolCalls, callbacks, depth = 0, signal) {
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

    // plan 模式：拒绝所有非只读工具
    if (agent.planMode && !tool.readonly) {
      prepared.push({ toolCall, tool, denied: true, reason: "plan mode" })
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
    if (item.denied) {
      const reason = item.reason === "plan mode"
        ? "Error: plan mode is active — only read-only tools are allowed. Exit plan mode first."
        : "Error: permission denied by user"
      return { ...item, result: reason }
    }
    try {
      const result = await item.tool.execute(item.args, {
        cwd: agent.cwd,
        agent,
        depth,
        signal,
        onOutput: (chunk) => callbacks.onToolOutput?.(item.toolCall.name, chunk),
        onQuestion: callbacks.onQuestion,
      })
      callbacks.onToolResult?.(item.toolCall.name, result)
      return { ...item, result: String(result) }
    } catch (error) {
      return { ...item, result: `Error: ${error.message}` }
    }
  }

  // 并行通道：只读工具 + 显式声明 parallel 的工具（subagent）；其余串行
  const parallelItems = prepared.filter((p) => p.tool?.readonly || p.tool?.parallel)
  const serialItems = prepared.filter((p) => p.tool && !p.tool.readonly && !p.tool.parallel)
  const failedItems = prepared.filter((p) => !p.tool)

  const parallelResults = await Promise.all(parallelItems.map(runOne))
  const serialResults = []
  for (const item of [...serialItems, ...failedItems]) {
    serialResults.push(await runOne(item))
  }

  // 按原始 toolCall 顺序合并（保持历史可读性；协议层靠 ID 配对，顺序无关正确性）
  const resultByCallId = new Map()
  for (const r of [...parallelResults, ...serialResults]) {
    resultByCallId.set(r.toolCall.id, r)
  }
  return toolCalls.map((tc) => resultByCallId.get(tc.id))
}
