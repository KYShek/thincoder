import {
  createAgent, runAgent, ContinueError,
  readonlyToolNames, collectGitContext, escapeXml,
  EXPLORE_OVERLAY, CODER_OVERLAY, PLAN_OVERLAY,
  MIN_REPORT_CHARS, REPORT_CONTINUATION, DEFAULT_SUBAGENT_TURNS,
} from "../agent.mjs"

/**
 * subagent tool: spawn a child agent to handle an independent subtask (isolated context, only the report is returned).
 * - role: "explore" — read-only tools, search/read/analyze (suitable for codebase exploration)
 * - role: "coder" — full tool set, self-contained implementation tasks (suitable for isolated coding)
 * - no role specified — default behavior, same tool set as parent agent
 * - parallel subagent calls via the parallel channel (parallel: true)
 * - non-recursive: child agents do not get the subagent tool (depth > 0 is not injected)
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
  sideEffectExempt: true, // child agent may write files; parent can't introspect its _mutatedThisRun
  parallel: true,
  async execute(args, ctx) {
    const parent = ctx.agent
    const role = args.role

    // Filter tool set by role: explore/plan are read-only (plan is a planning agent, its deliverable is the plan itself)
    let tools
    if (role === "explore" || role === "plan") {
      const allowed = readonlyToolNames(parent.tools)
      tools = parent.tools.filter((t) => allowed.has(t.name))
    } else {
      tools = parent.tools
    }

    // Select prompt overlay by role
    let overlay = ""
    if (role === "explore") overlay = EXPLORE_OVERLAY
    else if (role === "coder") overlay = CODER_OVERLAY
    else if (role === "plan") overlay = PLAN_OVERLAY

    // explore/plan: force read-only permission; coder/default: AUTO passes through directly,
    // manual mode queues permission requests for the parent agent's approval UI (human in the loop, child agent is no longer silently rejected)
    let childPermission
    if (role === "explore" || role === "plan") {
      childPermission = async () => false
    } else if (parent.autoApprove) {
      childPermission = async () => true
    } else {
      childPermission = async (name, toolArgs) => {
        if (!ctx.onPermissionRequest) return false
        const ask = () => ctx.onPermissionRequest(`${role ?? "sub"}/${name}`, toolArgs)
        // Queue parallel child agent permission requests to avoid two popups simultaneously overwriting each other (lesson from question tool)
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

    // explore/plan: inject git context (branch/recent commits/working tree state) — exploration and planning both relate to current repo state (inspired by kimi-code's promptPrefix)
    let input = args.context ? `Context:\n${args.context}\n\nTask:\n${args.task}` : args.task
    if (role === "explore" || role === "plan") {
      const gitCtx = collectGitContext(parent.cwd)
      if (gitCtx) input = `<untrusted_git_context>\n${escapeXml(gitCtx)}\n</untrusted_git_context>\n\n${input}`
    }

    // Relay content/reasoning tokens + tool calls to the parent TUI (child agent panel shows activity).
    // Prefix includes a unique id: parallel child agents with the same role stay independent and don't overwrite each other.
    // Format: role#id/  →  onToken("coder#2/writing..."), onToolCall("coder#2/read", args)
    parent._subAgentCounter = (parent._subAgentCounter ?? 0) + 1
    const subId = parent._subAgentCounter
    const relayPrefix = `${role ?? "sub"}#${subId}/`
    const childOpts = {
      onPermissionRequest: childPermission,
      onToken: ctx.callbacks?.onToken
        ? (t) => ctx.callbacks.onToken(`${relayPrefix}${t}`)
        : null,
      onReasoning: ctx.callbacks?.onReasoning
        ? (t) => ctx.callbacks.onReasoning(`${relayPrefix}${t}`)
        : null,
      onToolCall: ctx.callbacks?.onToolCall
        ? (name, args) => ctx.callbacks.onToolCall(`${relayPrefix}${name}`, args)
        : null,
    }
    const childRunOpts = { depth: (ctx.depth ?? 0) + 1, maxTurns: DEFAULT_SUBAGENT_TURNS }
    let report = await runAgent(child, input, childOpts, childRunOpts)

    // Report too short = incomplete handoff: send back for expansion once (inspired by kimi-code's summaryPolicy: min 200 chars, retry 1 time).
    // The child agent's history is still intact; the continuation instruction is appended as new input so it can see its own earlier work.
    if (report.length < MIN_REPORT_CHARS) {
      report = await runAgent(child, REPORT_CONTINUATION, childOpts, childRunOpts)
    }

    return report
  },
}
