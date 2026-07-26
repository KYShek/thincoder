/**
 * goal 工具：长程自主目标的生命周期管理（完成合约制）。
 * 三态：active / complete / blocked；完成要过 verify 证据门槛，
 * 阻塞要同一条件连续 3 次才受理；系统每轮注入状态 + 预算进度 + 审计纪律。
 */
export const goalTool = {
  name: "goal",
  description:
    "Manage a long-running autonomous goal (completion contract, not a wish). " +
    "action='set': create/replace the goal. The objective must have a VERIFIABLE end state — criteria must name a machine-checkable proof (tests pass, a command's output, a search result), not effort ('implement X') or vagueness ('works correctly'). If the task has no way to prove completion, help the user add one first — or don't set a goal. " +
    "action='complete': mark the goal achieved. Only when the criteria's check has actually run and passed — weak or indirect evidence, plans, and summaries are NOT completion. If you modified files, verify must have run first. " +
    "action='blocked': report an impasse (requires 'reason'). Allowed only after the SAME blocking condition persists across 3 genuine attempts with different approaches — the tool counts. " +
    "action='cancel': abandon the goal (explain why to the user).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "complete", "blocked", "cancel"], description: "Goal lifecycle action" },
      objective: { type: "string", description: "What you are trying to accomplish (for 'set')" },
      criteria: { type: "string", description: "How completion is PROVEN: the exact check to run, e.g. 'npm test passes', 'grep finds no TODO marker' (required for 'set')" },
      reason: { type: "string", description: "The blocking condition (required for 'blocked')" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    const agent = ctx.agent
    if (args.action === "cancel") {
      agent.goal = null
      return "Goal cancelled. If the goal was blocked or impossible, explain why in your next message — the user can clarify, adjust scope, or confirm cancellation."
    }
    if (args.action === "set") {
      if (!args.objective) return "Error: 'objective' required for 'set' action."
      if (!args.criteria) {
        return "Error: 'criteria' required for 'set' — a goal without a machine-checkable proof of completion is a wish, not a goal. Name the exact check (tests, command output, search result) that proves it's done."
      }
      agent.goal = {
        objective: String(args.objective).slice(0, 500),
        criteria: String(args.criteria).slice(0, 500),
        setAt: Date.now(),
        status: "active",
        turnsUsed: 0,
        _blockTally: null, // { reason, count } — 同一阻塞条件的连续次数（blocked 审计用）
      }
      return `Goal set: ${agent.goal.objective}\nDone when: ${agent.goal.criteria}\nThe system will inject goal status every turn. Completion and blocked claims are audited — see the reminders.`
    }
    if (!agent.goal || agent.goal.status !== "active") {
      return `Error: no active goal to '${args.action}' (current: ${agent.goal?.status ?? "none"}). Set one first.`
    }
    if (args.action === "complete") {
      // 证据链门槛：本轮改过文件却没跑过 verify，不许宣布完成（对齐完成守卫）
      if (agent._mutatedThisRun && !agent._verifiedThisRun) {
        return "Error: files were modified but verify has not run. Run the check your criteria names AND the verify tool before marking the goal complete — false completion is the worst outcome of autonomous work."
      }
      agent.goal.status = "complete"
      return `Goal marked complete: ${agent.goal.objective}\nIn your next message, summarize the evidence (what check ran, what it showed) — the user should be able to audit this claim.`
    }
    if (args.action === "blocked") {
      if (!args.reason) return "Error: 'reason' required for 'blocked' action."
      // 阻塞审计：同一条件须连续出现 3 次（换过方法仍被同一条件挡住才算真阻塞）
      const tally = agent.goal._blockTally
      const count = tally?.reason === args.reason ? tally.count + 1 : 1
      agent.goal._blockTally = { reason: args.reason, count }
      if (count < 3) {
        return `Blocked not accepted yet (${count}/3 for this condition). Try a genuinely different approach first; report blocked only if the same condition stops you ${3 - count} more time(s).`
      }
      agent.goal.status = "blocked"
      return `Goal marked blocked after 3 attempts: ${args.reason}\nExplain the blocker to the user in your next message — what you tried, and what you need (clarification, permission, a decision).`
    }
    return `Error: unknown action '${args.action}'.`
  },
}
