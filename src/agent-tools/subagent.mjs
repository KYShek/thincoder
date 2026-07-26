import {
  createAgent, runAgent, ContinueError,
  readonlyToolNames, collectGitContext, escapeXml,
  EXPLORE_OVERLAY, CODER_OVERLAY, PLAN_OVERLAY,
  MIN_REPORT_CHARS, REPORT_CONTINUATION, DEFAULT_SUBAGENT_TURNS,
} from "../agent.mjs"

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
    "Spawn a sub-agent to handle an independent subtask in an isolated context. The sub-agent returns only its final report. Spawn MULTIPLE subagents in the SAME response for parallel work—they run concurrently. Use role='explore' for codebase search/analysis (read-only, fast), role='plan' for read-only implementation planning (returns a step-by-step plan, never edits), role='coder' for self-contained implementation tasks. Do not give parallel subagents tasks that edit the same files.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Self-contained task description for the sub-agent" },
      context: { type: "string", description: "Optional background the sub-agent needs (it cannot see this conversation)" },
      role: { type: "string", enum: ["explore", "plan", "coder"], description: "Sub-agent role: 'explore' (read-only search/analysis), 'plan' (read-only implementation planning), or 'coder' (full implementation). Default: same tools as parent." },
    },
    required: ["task"],
  },
  readonly: false,
  parallel: true,
  async execute(args, ctx) {
    const parent = ctx.agent
    const role = args.role

    // 按 role 过滤工具集：explore/plan 只读（plan 是规划 agent，交付物是计划本身）
    let tools
    if (role === "explore" || role === "plan") {
      const allowed = readonlyToolNames(parent.tools)
      tools = parent.tools.filter((t) => allowed.has(t.name))
    } else {
      tools = parent.tools
    }

    // 按 role 选择 prompt overlay
    let overlay = ""
    if (role === "explore") overlay = EXPLORE_OVERLAY
    else if (role === "coder") overlay = CODER_OVERLAY
    else if (role === "plan") overlay = PLAN_OVERLAY

    // explore/plan 强制只读权限；coder/默认角色：AUTO 直接放行，
    // 手动模式把权限请求排队透传给父 agent 的审批 UI（人在回路，子 agent 不再被静默拒绝）
    let childPermission
    if (role === "explore" || role === "plan") {
      childPermission = async () => false
    } else if (parent.autoApprove) {
      childPermission = async () => true
    } else {
      childPermission = async (name, toolArgs) => {
        if (!ctx.onPermissionRequest) return false
        const ask = () => ctx.onPermissionRequest(`${role ?? "sub"}/${name}`, toolArgs)
        // 并行子 agent 的权限请求排队，避免两个审批同时弹出互相覆盖（question 工具的教训）
        parent._permQueue = (parent._permQueue ?? Promise.resolve()).then(ask, ask)
        return parent._permQueue
      }
    }

    const child = createAgent({
      provider: parent.provider,
      tools,
      config: parent.config,
      cwd: parent.cwd,
      memory: parent.memory,
      overlay,
      role,
    })

    // explore/plan：注入 git 上下文（分支/最近提交/工作区状态）——探索与规划都和仓库现状有关（借鉴 kimi-code 的 promptPrefix）
    let input = args.context ? `背景：\n${args.context}\n\n任务：\n${args.task}` : args.task
    if (role === "explore" || role === "plan") {
      const gitCtx = collectGitContext(parent.cwd)
      if (gitCtx) input = `<untrusted_git_context>\n${escapeXml(gitCtx)}\n</untrusted_git_context>\n\n${input}`
    }

    // 只 relay 正文/思考 token（TUI 滚动 2 行显示子 agent 活动）；
    // 不 relay 内部工具调用——子 agent 每次 read/grep 都往对话区刷一行就满屏了，
    // 内部活动由流式 token 概括，最终报告经父 agent 的 subagent 工具结果回到对话区
    const relayPrefix = role ? `${role}/` : "sub/"
    const childOpts = {
      onPermissionRequest: childPermission,
      onToken: ctx.callbacks?.onToken
        ? (t) => ctx.callbacks.onToken(`${relayPrefix}${t}`)
        : null,
      onReasoning: ctx.callbacks?.onReasoning
        ? (t) => ctx.callbacks.onReasoning(`${relayPrefix}${t}`)
        : null,
    }
    const childRunOpts = { depth: (ctx.depth ?? 0) + 1, maxTurns: DEFAULT_SUBAGENT_TURNS }
    let report = await runAgent(child, input, childOpts, childRunOpts)

    // 报告太短 = 交接不完整：打回扩写一次（借鉴 kimi-code 的 summaryPolicy：min 200 字符、重试 1 次。
    // 子 agent 的 history 还在，续写指令作为新输入追加，它能看到自己刚才的工作）
    if (report.length < MIN_REPORT_CHARS) {
      report = await runAgent(child, REPORT_CONTINUATION, childOpts, childRunOpts)
    }

    return report
  },
}
