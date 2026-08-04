/**
 * advisor.mjs — advisor system-prompt selection, follow-up building, session assembly.
 * User-message building lives in advisor/messages.mjs; execution (tool loop, provider
 * resolution, review entry) in advisor/run.mjs; history extraction in advisor/history.mjs.
 * repos.mjs still hosts the doc-file classifier (isDocFile) used by mutation tracking.
 *
 * The advisor runs as a read-only exploration sub-agent with tools
 * (read, glob, grep, ls, lsp, code_search) — ZERO git, every round. The change
 * surface comes from the review scope (paths / _touchedFiles), never from git;
 * verification is `read`-only with quoted-line evidence (7d49a52, d3be613).
 *
 * Config:
 *   { advisor: { enabled: true, provider: "deepseek", model: "deepseek-chat" } }
 *   provider + model are optional — defaults to the main agent's provider/model.
 *
 * Convergence protocol:
 *   Round 1: full review → produces a numbered issue table.
 *   Agent responds with a response table per issue.
 *   Round 2: semi-convergence — verifies table + can flag obvious new issues.
 *   Round 3+: strict convergence — only checks the prior issue table.
 *   Each round replaces the system prompt (ROUND1 → ROUND2 → ROUND3) so the
 *   round-1 full-scope mandate can't bleed into later rounds, plus a mechanical
 *   cap (MAX_ADVISOR_ROUNDS in run.mjs) refuses a 6th review call outright.
 *   Rounds 2+ also declare all earlier diffs STALE and require read-verified
 *   file:line evidence for any unfixed/new finding — see docs/design/ADVISOR-CONVERGENCE.md.
 *
 * Session memory (agent._advisorSession):
 *   RETAINED for initialization compatibility but NEVER read (decision d698434):
 *   every review round builds a fresh [system, user] session — round 2+ must not
 *   reuse round 1's messages, because the old read outputs are the anchoring
 *   source of re-review false reports and a token sink. Convergence data (prior
 *   issue table + agent response table) travels via buildAdvisorFollowUp.
 *   The field is reset by runAgent; the write sites are harmless leftovers.
 *
 * Project customisation: .thincoder/advisor.md in the project root.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { extractPriorIssueTable, extractAgentResponseTable } from "./advisor/history.mjs"
import { buildAdvisorUserMessage } from "./advisor/messages.mjs"
// Re-export for run.mjs and tests (keeps their imports from "../advisor.mjs" stable)
export { ADVISOR_MD_PATH, extractPriorIssueTable, extractAgentResponseTable, extractConversationBackground } from "./advisor/history.mjs"
export { buildAdvisorUserMessage } from "./advisor/messages.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ────────────────────────────────────────
// Prompt files — loaded at module init
// ────────────────────────────────────────

const ADVISOR_ROUND1 = readFileSync(join(__dirname, "prompts", "advisor-round1.md"), "utf8")
// ROUND2/3 are used whenever a convergence round (round 2+) is being built:
// in-run session continuation replaces the system prompt with them, and a
// rebuilt fresh session (e.g. after a failed review) also selects them via
// buildAdvisorSystemPrompt when _advisorRound > 0.
const ADVISOR_ROUND2 = readFileSync(join(__dirname, "prompts", "advisor-round2.md"), "utf8")
const ADVISOR_ROUND3 = readFileSync(join(__dirname, "prompts", "advisor-round3.md"), "utf8")
// Fallback when advisor-design.md is missing — keep in sync with the real file.
const ADVISOR_DESIGN_FALLBACK = `You are an independent design reviewer for an engineering-mode project. Review the design document in the changes below. Evaluate: completeness, feasibility, clarity, scope, acceptance criteria. Read METHODOLOGY.md if provided. Produce a review table with | # | Category | Severity | Issue | Suggestion | format.`
let ADVISOR_DESIGN = ""
try { ADVISOR_DESIGN = readFileSync(join(__dirname, "prompts", "advisor-design.md"), "utf8") } catch { /* fallback below */ }

// ────────────────────────────────────────
// System prompt building
// ────────────────────────────────────────

/**
 * Build the system prompt for an advisor review session.
 * @param {Object} agent — the parent agent
 * @param {Object|null} [_prior] — prior issue table (from extractPriorIssueTable)
 * @param {string} [reviewType] — "design" for design review, undefined/"code" for code review
 * @returns {string} the system prompt
 */
export function buildAdvisorSystemPrompt(agent, _prior, reviewType) {
  // Design review: round 1 uses the dedicated design-review prompt (full scope +
  // approval token); rounds 2+ converge like code reviews (verify prior table).
  if (reviewType === "design") {
    const prior = _prior ?? extractPriorIssueTable(agent.history)
    if (!prior || (agent._advisorRound || 0) === 0) {
      return ADVISOR_DESIGN || ADVISOR_DESIGN_FALLBACK
    }
    const round = (agent._advisorRound || 0) + 1
    if (round === 2) return ADVISOR_ROUND2
    return ADVISOR_ROUND3
  }
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  if (!prior || (agent._advisorRound || 0) === 0) return ADVISOR_ROUND1
  const round = (agent._advisorRound || 0) + 1
  if (round === 2) return ADVISOR_ROUND2
  return ADVISOR_ROUND3
}

// ────────────────────────────────────────
// Follow-up building (round 2+)
// ────────────────────────────────────────

/**
 * Build a follow-up user message for round 2+ — the agent's response table +
 * round-aware instructions, without re-sending the full round-1 context.
 * Deliberately NO git information injected (no diff snapshot, no git context):
 * git output misled re-reviews — committed fixes never show in `git diff HEAD`,
 * so the model read "no changes" as "no fixes". Verification is `read`-only.
 */
export function buildAdvisorFollowUp(agent, _prior) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  const response = extractAgentResponseTable(agent.history, prior?.sinceIdx ?? 0)
    || "(Agent did not provide a response table — re-evaluate each issue)"
  const round = (agent._advisorRound || 0) + 1
  const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"

  const parts = [
    `## Round ${round} — ${label}`,
    "",
    `[System reminder: this is round ${round} of the convergence protocol. The system prompt for this round has already narrowed the review scope — follow it: ${round === 2 ? "verify the prior table and flag only obvious new issues introduced by the fixes" : "strictly verify only the prior table — do NOT look for new issues"}.]`,
    "",
    "## Prior Issue Table",
    prior?.text ?? "(no prior table — review from scratch)",
    "",
    "## Agent Response",
    response,
    "",
    "## Instructions",
    round === 2
      ? "Verify each item in the prior table. Flag any obvious NEW issues introduced by the fixes (crashes, data loss, logic errors — not style). Produce a verification table."
      : "Strictly verify ONLY the items in the prior table against the CURRENT FILE STATE (use `read` — an empty diff does not mean the fixes are absent). Do NOT look for new issues.",
    "",
    "IMPORTANT: the prior issue table is HISTORY — always verify current file state with `read` before judging an item as fixed or unfixed.",
    // Round-aware evidence rule: "New" entries only exist in round 2 (round 3+ forbids them).
    `STALE-CONTEXT WARNING: only fresh \`read\` results describe the current state — never judge from earlier snapshots or from \`git diff\` (committed fixes never show in \`git diff HEAD\`). Read the files to verify. Any "Unfixed" entry${round === 2 ? ' (and any "New" entry)' : ""} MUST quote the exact line content from THIS round's \`read\` output (e.g. \`run.mjs:180: timeoutId = setTimeout(...)\`); line numbers alone are NOT evidence (they may come from the stale prior table). Uncited findings are unverified and will be ignored.`,
    "",
    "Do NOT re-read AGENTS.md / design docs unless a prior-table item names them. Verify fix status with `read` only — you have no git tool this round; git output in earlier messages is historical and untrustworthy (committed fixes never show in a diff).",
    "",
  ]
  return parts.join("\n")
}

/**
 * Build the advisor conversation for this run.
 * EVERY call builds a fresh [system, user] session (decision d698434) — no
 * session reuse across rounds: round 1 = full scope (ROUND1 prompt), rounds
 * 2+ = convergence (ROUND2/ROUND3 prompt + prior-table follow-up).
 * @param {string[]|null} [paths] — code review only: explicit list of file/dir paths to review
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — design-review approval token (design only)
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review (passed through to buildAdvisorUserMessage)
 */
export function prepareAdvisorMessages(agent, reviewType, designToken = null, documents = null, paths = null) {
  const prior = extractPriorIssueTable(agent.history)

  // Design review round 1: the dedicated full-scope review with the approval
  // token (an independent gate — it runs even when a prior table exists, e.g.
  // after a failed design review). Fresh session.
  if (reviewType === "design" && (agent._advisorRound || 0) === 0) {
    return [
      { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
      { role: "user", content: buildAdvisorUserMessage(agent, prior, reviewType, designToken, documents, paths) },
    ]
  }

  // Every round is a FRESH session (decision d698434): round 2+ must NOT reuse
  // round 1's messages — the old read outputs are the top anchoring source of
  // re-review false reports (the model quoted pre-fix file content instead of
  // re-reading) and a token sink. The prior table + agent response table are
  // injected through buildAdvisorFollowUp instead; the system prompt carries
  // the round (ROUND2/ROUND3) via buildAdvisorSystemPrompt.
  // Guard matches buildAdvisorSystemPrompt's ROUND1 condition
  // (`!prior || _advisorRound === 0`): a stale prior table with _advisorRound 0
  // (history persists across runAgent calls) must yield a fresh round-1 review —
  // ROUND1 system prompt + full-scope user message, never the verify-prior
  // follow-up (which would contradict the ROUND1 system prompt).
  if (!prior || (agent._advisorRound || 0) === 0) {
    // No prior table = new review cycle (first review, all-clear, or session
    // clear): reset the round so the prompt (ROUND1) and tool set stay
    // consistent, and the cycle gets its own 5-round budget.
    agent._advisorRound = 0
    const user = buildAdvisorUserMessage(agent, prior, reviewType, designToken, documents, paths)
    return [
      { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
      {
        role: "user",
        content: `[System reminder: no prior issue table is being carried into this review (first review, app restart, or session clear) — start with a fresh full review.]\n\n${user}`,
      },
    ]
  }

  // Convergence rounds (2+): fresh [system(ROUND2/3), user(prior table +
  // response table + round instructions)]. buildAdvisorFollowUp carries the
  // prior/response tables; buildAdvisorSystemPrompt selects ROUND2 for round 2,
  // ROUND3 for rounds 3+ — a failed review retry keeps _advisorRound so the
  // convergence prompt matches the attempt count.
  return [
    { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
    { role: "user", content: buildAdvisorFollowUp(agent, prior) },
  ]
}
