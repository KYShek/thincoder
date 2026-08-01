import {
  createAgent, runAgent, ContinueError,
  readonlyToolNames, collectGitContext, escapeXml,
  EXPLORE_OVERLAY, CODER_OVERLAY, PLAN_OVERLAY, ENG_CODER_OVERLAY,
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
    "Spawn a sub-agent to handle an independent subtask in an isolated context. The sub-agent returns only its final report. Spawn MULTIPLE subagents in the SAME response for parallel work—they run concurrently.\n" +
    "Use role='explore' for codebase search/analysis (read-only, fast), role='plan' for read-only implementation planning (returns a step-by-step plan, never edits), role='coder' for self-contained implementation tasks. Do not give parallel subagents tasks that edit the same files.\n\n" +
    "Writing the prompt:\n" +
    "- The sub-agent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\n" +
    "- Put exact paths and commands in the prompt when you know them. The sub-agent should not search for things you already know.\n" +
    "- Do not delegate understanding: if the task hinges on a file path or line number, find it yourself first and write it into the prompt.\n" +
    "- Once a sub-agent is running, leave that scope to it: don't redo its searches in parallel, and don't abandon it midway to finish manually.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Self-contained task description for the sub-agent" },
      context: { type: "string", description: "Optional background the sub-agent needs (it cannot see this conversation)" },
      role: { type: "string", enum: ["explore", "plan", "coder", "eng-coder"], description: "Sub-agent role: 'explore' (read-only search/analysis), 'plan' (read-only implementation planning), 'coder' (full implementation), 'eng-coder' (engineering-mode coder — strict methodology, design-driven). ENUM IS OVERRIDDEN IN setup.mjs PER ENGINEERING MODE." },
      designToken: { type: "string", description: "Required when role='eng-coder': the token returned by advisor(type='design') after the design review passed. Without a valid token, eng-coder cannot modify files." },
    },
    required: ["task"],
  },
  readonly: false,
  sideEffectExempt: true, // child agent may write files; parent can't introspect its _mutatedThisRun
  parallel: true,
  async execute(args, ctx) {
    const parent = ctx.agent
    const role = args.role

    // Role is mutually exclusive per mode: normal mode → "coder", engineering mode → "eng-coder"
    if (parent.config?.agent?.engineering && role === "coder") {
      throw new Error("Engineering mode: use role='eng-coder' for implementation tasks.")
    }
    if (!parent.config?.agent?.engineering && role === "eng-coder") {
      throw new Error("Engineering mode is not active — use role='coder' for implementation tasks.")
    }

    // eng-coder token gate: the design review must have passed and the caller must
    // present the exact token advisor issued — otherwise the child is not authorized to code.
    if (role === "eng-coder") {
      const issued = parent._engDesignToken
      if (!issued || args.designToken !== issued) {
        throw new Error("Invalid or missing design token — run advisor with type='design' first and pass the returned token as designToken.")
      }
    }

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
    else if (role === "eng-coder") overlay = ENG_CODER_OVERLAY

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

    // eng-coder: force engineering=true on child config so setup.mjs applies engineering prompt
    const childConfig = role === "eng-coder"
      ? { ...parent.config, agent: { ...parent.config.agent, engineering: true } }
      : parent.config

    const child = createAgent({
      provider: parent.provider,
      tools,
      config: childConfig,
      cwd: parent.cwd,
      memory: parent.memory,
      overlay,
      role,
    })

    // Token-verified design review → child is authorized to modify files without re-reviewing
    if (role === "eng-coder") child._engDesignReviewed = true

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
    const childRunOpts = { depth: (ctx.depth ?? 0) + 1, maxTurns: ctx.agent?.config?.agent?.subagentTurns ?? DEFAULT_SUBAGENT_TURNS }
    let report = await runAgent(child, input, childOpts, childRunOpts)

    // Report too short = incomplete handoff: send back for expansion once (inspired by kimi-code's summaryPolicy: min 200 chars, retry 1 time).
    // The child agent's history is still intact; the continuation instruction is appended as new input so it can see its own earlier work.
    if (report.length < MIN_REPORT_CHARS) {
      report = await runAgent(child, REPORT_CONTINUATION, childOpts, childRunOpts)
    }

    // Engineering mode mechanical code gate: delegated file changes must not
    // bypass the parent's advisor/verify guards. Merge the child's mutations
    // into the parent so "advisor mandatory at both gates" is enforced, not just
    // promised in the engineering prompt.
    if (role === "eng-coder") mergeChildMutations(parent, child)

    return report
  },
}

/**
 * Merge an eng-coder child's mutations into the parent agent's bookkeeping.
 * The parent must stay aware of delegated file changes: its `_touchedFiles`
 * feed `runAdvisorReview`'s engineering-mode exemption and any opt-in guards
 * (verifyGuard / advisor.guard), and a prior verify/advisor is invalidated
 * because it judged an older state.
 *
 * `_advisorRound` is reset to 0: merged code is new code that deserves a fresh
 * convergence budget. Mirrors the design-review reset semantics.
 *
 * Returns true when mutations were merged (kept for future caller checks).
 */
export function mergeChildMutations(parent, child) {
  if (!child._mutatedThisRun) return false
  parent._mutatedThisRun = true
  for (const abs of child._touchedFiles ?? []) {
    if (!parent._touchedFiles.includes(abs)) parent._touchedFiles.push(abs)
  }
  if (parent._calledAdvisorThisRun) parent._calledAdvisorThisRun = false
  if (parent._verifiedThisRun) {
    parent._verifiedThisRun = false
    parent._verifyPassed = undefined
  }
  // Fresh code → fresh convergence budget + stale session/diff cleanup.
  // _advisorRound reset ensures new code gets a full round-1 review;
  // _advisorSession + _advisorLastSnapshot prevent cross-contamination.
  parent._advisorRound = 0
  parent._advisorSession = null
  parent._advisorLastSnapshot = null
  return true
}