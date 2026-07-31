/**
 * agent-tools/advisor.mjs — advisor tool wrapper.
 * The agent calls this explicitly to get an independent review.
 * type="design" for design doc review, type="code" for code review (default).
 */
import { runAdvisorReview } from "../advisor.mjs"

export const advisorTool = {
  name: "advisor",
  description:
    "Run an independent review on your work. " +
    "Use type='design' to review a design document before implementation. " +
    "Use type='code' (default) to review code changes after implementation. " +
    "The advisor is an independent read-only sub-agent that explores the codebase, runs git diff, " +
    "reads files, and traces callers via grep/lsp. " +
    "For code review: round 1 does a full review, round 2 verifies the prior table, " +
    "round 3+ strictly checks only the prior table — convergence, not divergence. " +
    "For design review: single-pass review against methodology and requirements. " +
    "Review criteria come from .thincoder/advisor.md (if present) or sensible defaults. " +
    "After the review, you MUST produce a response table (see discipline rules for format). " +
    "If advisor says all clear, call verify.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["code", "design"], description: "Review type: 'design' for design doc review, 'code' for code review (default)" },
    },
  },
  readonly: true,
  sideEffectExempt: true,
  outputPanel: true,
  async execute(args, ctx) {
    const agent = ctx.agent
    const reviewType = args.type || "code"

    // Design review: always starts from round 1 (no convergence)
    if (reviewType === "design") {
      agent._advisorRound = 0
      agent._advisorSession = null
    }

    const result = await runAdvisorReview(agent, reviewType, ctx.callbacks)
    // Design reviews don't converge — discard session and round state
    if (reviewType === "design") {
      agent._advisorSession = null
      agent._advisorRound = 0
    }
    return result ?? "Advisor: review is disabled or no changes to review."
  },
}
