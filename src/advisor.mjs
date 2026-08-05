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
 *   Agent responds with a response table per issue (fix claims).
 *   Round 2: semi-convergence — verifies the fix claims + can flag obvious new issues.
 *   Round 3+: strict convergence — only checks the agent fix claims.
 *   The prior issue table is NEVER injected into rounds 2+ (decision 2026-08-05) —
 *   it was the strongest restatement anchor; only the agent's fix claims travel.
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
import { buildAdvisorUserMessage, buildConvergenceInstructions, resolveScopeFiles } from "./advisor/messages.mjs"
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
 * @param {Object|null} [prior] — prior issue table (from extractPriorIssueTable)
 * @param {string} [reviewType] — "design" for design review, undefined/"code" for code review
 * @returns {string} the system prompt
 */
export function buildAdvisorSystemPrompt(agent, prior, reviewType) {
  // Design review: round 1 uses the dedicated design-review prompt (full scope +
  // approval token); rounds 2+ converge like code reviews (verify agent fix claims).
  if (reviewType === "design") {
    const p = prior ?? extractPriorIssueTable(agent.history)
    if (!p || (agent._advisorRound || 0) === 0) {
      return ADVISOR_DESIGN || ADVISOR_DESIGN_FALLBACK
    }
    const round = (agent._advisorRound || 0) + 1
    if (round === 2) return ADVISOR_ROUND2
    return ADVISOR_ROUND3
  }
  const p = prior ?? extractPriorIssueTable(agent.history)
  if (!p || (agent._advisorRound || 0) === 0) return ADVISOR_ROUND1
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
 * @param {Object} agent — the parent agent (history used for the response table)
 * @param {Object|null} prior — prior issue table (extracted from history when null)
 * @param {string[]|null} [scopeFiles] — review surface for the no-response fallback (cwd-relative)
 * @returns {string} the follow-up user message — or a "[System reminder: …]" fresh-review
 *   fallback when NO prior review exists at all (caller misuse; the response-table
 *   extraction would otherwise scan history from index 0 and could match an
 *   unrelated stale table)
 */
export function buildAdvisorFollowUp(agent, prior, scopeFiles = null) {
  // Convergence follow-up REQUIRES a prior review record. The caller usually
  // passes it; fall back to extracting it from history (compat for direct
  // callers/tests). If there is genuinely no prior review, a nullish table
  // would make the response-table extraction scan from index 0 and possibly
  // match an unrelated stale table — return a round-1-style message instead.
  const p = prior ?? extractPriorIssueTable(agent.history)
  if (!p) {
    return "[System reminder: convergence follow-up requested without a prior review — perform a fresh full review.]"
  }
  const noResponseFallback = scopeFiles?.length
    ? "(Agent did not provide a response table — perform a fresh review of: " + scopeFiles.slice(0, 10).join(", ") + ")"
    : "(Agent did not provide a response table — perform a fresh full review; the review surface is unknown, ask the user for the file list)"
  const response = extractAgentResponseTable(agent.history, p.sinceIdx) || noResponseFallback
  const round = (agent._advisorRound || 0) + 1
  const label = round === 2 ? "Verify Agent Fixes + Flag New Issues" : "Strict Verification"

  const reminder = round === 2
    ? "verify the fixes the agent claims and flag only obvious new issues introduced by them"
    : "strictly verify only the fixes the agent claims — do NOT look for new issues"
  const parts = [
    `## Round ${round} — ${label}`,
    "",
    `[System reminder: this is round ${round} of the convergence protocol. ` +
      `The system prompt for this round has already narrowed the review scope — follow it: ${reminder}.]`,
    "",
    // No prior issue table in the context — see module docstring for the
    // rationale (decision 2026-08-05). scopeFiles names the review surface
    // when the agent gave no response table.
    "## Agent Response (fix claims to verify)",
    response,
    "",
    "## Instructions",
    ...buildConvergenceInstructions(round, scopeFiles),
    "",
  ]
  return parts.join("\n")
}

/**
 * Resolve the review surface for the convergence fallback — moved to
 * messages.mjs so the legacy path shares it (see there).
 */

/**
 * Build the advisor conversation for this run.
 * EVERY call builds a fresh [system, user] session (decision d698434) — no
 * session reuse across rounds: round 1 = full scope (ROUND1 prompt), rounds
 * 2+ = convergence (ROUND2/ROUND3 prompt + fix-claims follow-up).
 * @param {Object} agent — the parent agent
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — design-review approval token (design only)
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review (passed through to buildAdvisorUserMessage)
 * @param {string[]|null} [paths] — code review only: explicit list of file/dir paths to review
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
  // re-reading) and a token sink. The agent response table (fix claims) is
  // injected through buildAdvisorFollowUp instead; the system prompt carries
  // the round (ROUND2/ROUND3) via buildAdvisorSystemPrompt.
  // Guard matches buildAdvisorSystemPrompt's ROUND1 condition
  // (`!prior || _advisorRound === 0`): a stale prior table with _advisorRound 0
  // (history persists across runAgent calls) must yield a fresh round-1 review —
  // ROUND1 system prompt + full-scope user message, never the convergence
  // (fix-claims) follow-up (which would contradict the ROUND1 system prompt).
  // No prior table: reset ONLY when this run made no code changes (user
  // decision 2026-08-05: any loop that modified code must NOT reset — the
  // advisor guard WILL push back, so the convergence round must keep advancing
  // toward the cap; a run with no mutations has no push-back risk and a reset
  // is safe). Deterministic runtime state (`_mutatedThisRun`) decides — never
  // model output (phrases/table headers drift; three rounds of false reports
  // proved it). Either way the message is a fresh full review (no issue list
  // exists without a prior table) — only the round counter differs.
  if (!prior) {
    if (!agent._mutatedThisRun) {
      // New review cycle (first review, all-clear, or no code changes): reset
      // the round so the cycle gets its own 5-round budget.
      agent._advisorRound = 0
    } else {
      // Mutations exist → KEEP the round (cap keeps advancing through retries).
    }
    const user = buildAdvisorUserMessage(agent, prior, reviewType, designToken, documents, paths)
    return [
      { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
      {
        role: "user",
        content: `[System reminder: no prior issue table is being carried into this review (first review, app restart, or session clear) — start with a fresh full review.]\n\n${user}`,
      },
    ]
  }

  // Convergence rounds (2+): fresh [system(ROUND2/3), user(fix claims + round
  // instructions)]. buildAdvisorFollowUp carries the agent's fix-claim table —
  // NO prior issue table in the context (decision 2026-08-05: it was the
  // strongest restatement anchor). buildAdvisorSystemPrompt selects ROUND2 for
  // round 2, ROUND3 for rounds 3+ — a failed review retry keeps _advisorRound
  // so the convergence prompt matches the attempt count. scopeFiles gives the
  // fallback (agent gave no response table) a concrete review surface.
  const scopeFiles = resolveScopeFiles(agent, paths)
  return [
    { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
    { role: "user", content: buildAdvisorFollowUp(agent, prior, scopeFiles) },
  ]
}
