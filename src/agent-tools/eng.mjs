/**
 * eng tool: enter/exit engineering mode.
 * In engineering mode the agent follows design-before-code methodology.
 * Toggled here at session level; persisted by /eng.
 */
const ENG_ON_REMINDER =
  "[System reminder: engineering mode is ON — design-before-code enforced. " +
  "Workflow: Requirements doc → Design doc → advisor(type='design') → " +
  "user approval → eng-coder implementation. Code changes go through eng-coder " +
  "subagents only. Advisor calls are NOT per-turn-mandatory — call only at " +
  "flow nodes or when the user asks.]"

export const engTool = {
  name: "eng",
  description:
    "Enter or exit engineering mode. In engineering mode, follow design-before-code: write a design document, run advisor design review, get user approval, then implement via eng-coder subagents.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["enter", "exit"], description: "Enter or exit engineering mode" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    ctx.agent.config.agent ??= {}
    if (args.action === "exit") {
      ctx.agent.config.agent.engineering = false
      ctx.agent._engDesignToken = null   // stale token from prior design review invalidated
      ctx.agent._lastEngState = false
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push(
        "[System reminder: engineering mode is now OFF — standard discipline applies. Changes go through the normal workflow.]")
      return "Engineering mode exited. Standard discipline now applies. You may edit files directly."
    }
    if (args.action === "enter") {
      ctx.agent.config.agent.engineering = true
      ctx.agent._engDesignToken = null   // re-entering requires a fresh design review
      ctx.agent._lastEngState = true
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push(ENG_ON_REMINDER)
      return "Engineering mode activated. Design-before-code enforced: write a design document in docs/, run advisor with type='design', get user approval, then implement via eng-coder subagents."
    }
    return "Invalid action: expected 'enter' or 'exit'"
  },
}
