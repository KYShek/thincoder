/**
 * agent-tools/advisor.mjs — advisor tool wrapper.
 * The agent calls this explicitly at the end of a coding task to get a code review.
 */
import { runAdvisorReview } from "../advisor.mjs"

export const advisorTool = {
  name: "advisor",
  description:
    "Run a code review on your changes (convergence protocol). " +
    "Call this when you have finished coding and want an independent review before finalising. " +
    "The advisor is an independent read-only sub-agent that explores the codebase, runs git diff, " +
    "reads files, and traces callers via grep/lsp. " +
    "Review criteria come from .thincoder/advisor.md (if present) or sensible defaults. " +
    "Round 1 does a full review and produces a numbered issue table. " +
    "After the review, you MUST produce a response table (see discipline rules for format). " +
    "Round 2 verifies the table + can flag obvious new issues. " +
    "Round 3+ strictly checks only the prior table — convergence, not divergence. " +
    "If issues are found, fix them, update your response table, then re-run advisor. " +
    "If advisor says all clear, call verify.",
  parameters: {
    type: "object",
    properties: {},
  },
  readonly: true,
  sideEffectExempt: true,
  outputPanel: true,
  async execute(_args, ctx) {
    const agent = ctx.agent

    const result = await runAdvisorReview(agent, ctx.onOutput, ctx.signal)
    if (!result) return "Advisor: review is disabled or no changes to review."

    return result
  },
}
