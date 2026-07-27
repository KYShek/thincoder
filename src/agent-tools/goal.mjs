/**
 * goal tool: lifecycle management for long-running autonomous goals (completion contract).
 * Three states: active / complete / blocked. Completion must pass a verify evidence threshold;
 * blocked is only accepted after the same condition persists 3 consecutive times.
 * The system injects status + budget progress + audit discipline every turn.
 */
export const goalTool = {
  name: "goal",
  description:
    "Manage a long-running autonomous goal. " +
    "action='set': create or replace the goal — must have a verifiable completion criterion (a machine-checkable proof, not vague effort). " +
    "action='complete': mark achieved — only after the criterion's check has actually passed. " +
    "action='blocked': report an impasse (requires 'reason') — only after 3 genuine attempts. " +
    "action='cancel': abandon the goal.",
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
        _blockTally: null, // { reason, count } — consecutive count of the same blocking condition (for blocked audit)
      }
      return `Goal set: ${agent.goal.objective}\nDone when: ${agent.goal.criteria}\nThe system will inject goal status every turn. Completion and blocked claims are audited — see the reminders.`
    }
    if (!agent.goal || agent.goal.status !== "active") {
      return `Error: no active goal to '${args.action}' (current: ${agent.goal?.status ?? "none"}). Set one first.`
    }
    if (args.action === "complete") {
      // Evidence chain threshold: files were mutated this run without verify — refuse completion (aligns with completion guard)
      if (agent._mutatedThisRun && !agent._verifiedThisRun) {
        return "Error: files were modified but verify has not run. Run the check your criteria names AND the verify tool before marking the goal complete — false completion is the worst outcome of autonomous work."
      }
      agent.goal.status = "complete"
      return `Goal marked complete: ${agent.goal.objective}\nIn your next message, summarize the evidence (what check ran, what it showed) — the user should be able to audit this claim.`
    }
    if (args.action === "blocked") {
      if (!args.reason) return "Error: 'reason' required for 'blocked' action."
      // Blocked audit: same condition must appear 3 consecutive times (only counts as real blocking if different approaches still hit the same wall)
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
