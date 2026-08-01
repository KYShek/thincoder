/**
 * agent-tools/advisor.mjs — advisor tool wrapper.
 * The agent calls this explicitly to get an independent review.
 * type="design" for design doc review, type="code" for code review (default).
 */
import { randomUUID } from "node:crypto"
import { runAdvisorReview } from "../advisor/run.mjs"

/** Build a [DESIGN-TOKEN:...] regex; escapes special chars as a safety net even though UUIDs contain only hex/hyphens.
 *  Anchored to its own line (multiline): an inline mention like "I would have included [DESIGN-TOKEN:x] but..." must NOT count as approval. */
const makeDesignTokenRegex = (token, flags = "") =>
  new RegExp(`^\\[DESIGN-TOKEN:\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, flags + "m")

export const advisorTool = {
  name: "advisor",
  description:
    "Run an independent review on your work. " +
    "Use type='design' to review design documents before implementation — pass documents=[...] with the explicit list of doc paths to review; use documents in code review too (the task's Docs involved list). " +
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
      documents: {
        type: "array",
        items: { type: "string" },
        description: "Explicit list of doc paths to review (design docs, requirements docs, referenced docs). The advisor reviews ONLY these — it does NOT scan git diff. Use for both design review and code review to pass the task's Docs involved list.",
      },
    },
  },
  readonly: true,
  sideEffectExempt: true,
  outputPanel: true,
  async execute(args, ctx) {
    const agent = ctx.agent
    const reviewType = args.type || "code"
    const documents = args.documents || null

    // Design review: always starts from round 1 (no convergence)
    if (reviewType === "design") {
      agent._advisorRound = 0
      agent._advisorSession = null
      agent._advisorLastSnapshot = null // stale diff dedup baseline must not leak into the next code review
    }

    // Generate the design token BEFORE the review and inject it into the advisor's prompt.
    // The advisor (LLM) decides pass/fail itself and echoes the token only on approval —
    // the gate is a mechanical string match, not fragile semantics parsing.
    const designToken = reviewType === "design" ? randomUUID() : null
    const result = await runAdvisorReview(agent, reviewType, {
      onOutput: ctx.onOutput,
      signal: ctx.signal,
    }, designToken, documents)

    if (reviewType === "design") {
      // Whitespace-tolerant match (LLM may add spaces or wrap in fences).
      // The token IS the verdict — the advisor echoes it only on approval (prompt-enforced);
      // no findings-table heuristics: a design with issues never carries the token.
      const tokenPattern = makeDesignTokenRegex(designToken)
      if (designToken && result && tokenPattern.test(result)) {
        // Advisor echoed the token → review passed. Issue it to the parent for eng-coder.
        // (session cleanup for design reviews is owned by runAdvisorReview)
        agent._engDesignToken = designToken
        // Unlock the dispatch design gate (dispatch.mjs) for eng-coder SELF-review:
        // an eng-coder whose own design review passed may write files without the
        // parent spawn-time authorization. NOTE: unreachable today — eng-coder.md
        // tells the child not to re-run the design review, and spawn already sets
        // _engDesignReviewed (subagent.mjs). Kept as defense-in-depth for a future
        // eng-coder autonomous design-revision entry. Parent agents (role undefined)
        // don't use this flag — their runAgent resets it anyway; they are trusted
        // via the engineering prompt.
        if (agent._role === "eng-coder") agent._engDesignReviewed = true
        // Strip the bracketed token so only ONE unambiguous format (plain UUID) reaches the main agent
        const cleanResult = result.replace(makeDesignTokenRegex(designToken, "g"), "").trim()
        return `${cleanResult}\n\nApproved. Pass this exact token to eng-coder (designToken parameter): ${designToken}`
      }
      // Review failed (or advisor chose not to pass) → invalidate any previously-issued token.
      // Guard: result === null means the review was skipped (advisor disabled / not engineering
      // mode) — a skipped review must not revoke an already-issued token.
      if (result !== null) agent._engDesignToken = null
      // Strip every dead token occurrence from the raw output so the main agent can't grab an invalid one
      if (result) {
        const stripped = result.replace(makeDesignTokenRegex(designToken, "g"), "").trim()
        return stripped || "Advisor: design review did not pass."
      }
    }
    return result
  },
}
