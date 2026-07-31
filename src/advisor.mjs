/**
 * advisor.mjs — advisor message building and history extraction.
 * Execution (tool loop, provider resolution, review entry) lives in advisor/run.mjs;
 * git discovery/collection in advisor/repos.mjs.
 *
 * The advisor runs as a read-only exploration sub-agent with tools
 * (read, glob, grep, ls, git, lsp, code_search). It discovers changes
 * via git diff, reads files for context, and traces callers via grep/lsp.
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
 *   No hard round cap — the convergence protocol naturally limits divergence.
 *
 * Session memory (agent._advisorSession):
 *   All advisor calls within one run share a single conversation — round 2+
 *   just appends a follow-up (agent response + refreshed diff + round rules),
 *   so the advisor keeps its exploration context instead of re-discovering
 *   everything. The session is discarded when the run ends (runAgent resets it);
 *   the next task starts a fresh advisor session. After an app restart the
 *   in-memory session is gone — falls back to a fresh session seeded from the
 *   issue/response tables in the main history.
 *
 * Project customisation: .thincoder/advisor.md in the project root.
 */
import { readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findReviewRepos, collectRepoSnapshots, collectChangedFiles } from "./advisor/repos.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ADVISOR_MD_PATH = ".thincoder/advisor.md"

const DEFAULT_CRITERIA = `Review the code changes, focusing on:
1. Correctness: logic errors, edge cases, off-by-one, incomplete modifications
2. Security: unhandled exceptions, null references, resource leaks, race conditions
3. Consistency: alignment with existing project patterns and conventions
4. Completeness: missing callers, imports, or follow-up changes
5. Maintainability: vague naming, missing comments, overly complex logic`

// ────────────────────────────────────────
// Prompt files — loaded at module init
// ────────────────────────────────────────

const ADVISOR_ROUND1 = readFileSync(join(__dirname, "prompts", "advisor-round1.md"), "utf8")
const ADVISOR_ROUND2 = readFileSync(join(__dirname, "prompts", "advisor-round2.md"), "utf8")
const ADVISOR_ROUND3 = readFileSync(join(__dirname, "prompts", "advisor-round3.md"), "utf8")
let ADVISOR_DESIGN = ""
try { ADVISOR_DESIGN = readFileSync(join(__dirname, "prompts", "advisor-design.md"), "utf8") } catch { /* design review unavailable */ }

// ────────────────────────────────────────
// History extraction — issue/response tables
// ────────────────────────────────────────

const ADVISOR_TABLE_HEADER = "| # | File | Severity | Issue | Suggestion |"
const CONVERGENCE_TABLE_HEADER = "| # | Orig# | File | Severity | Status | Notes |"
const AGENT_RESPONSE_HEADER = "| # | Action | Detail |"
const LEGACY_ADVISOR_HEADER = "| # | 文件 | 严重程度 | 问题描述 | 建议修复 |"

/**
 * Extract the most recent advisor review table from history.
 * Returns { text, sinceIdx } where sinceIdx is the history index AFTER the
 * advisor call — used to locate the agent's response table that follows it.
 * Returns null when: no advisor call, empty output, or the last review is
 * all-clear (nothing to follow up on).
 */
export function extractPriorIssueTable(history) {
  const allClear = ["all clear", "全部通过", "已修复", "review passed", "no issues found", "no new issues"]
  const entries = Array.isArray(history) ? history : []

  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]
    if (m.role !== "tool" || typeof m.content !== "string") continue
    // Only review outputs carry one of these table headers
    if (!m.content.includes(ADVISOR_TABLE_HEADER)
      && !m.content.includes(CONVERGENCE_TABLE_HEADER)
      && !m.content.includes(LEGACY_ADVISOR_HEADER)) continue
    const text = m.content
    const lower = text.toLowerCase()
    if (allClear.some((s) => lower.includes(s))) return null
    // sinceIdx = the advisor call's own index; extractAgentResponseTable skips it (role !== assistant)
    return { text, sinceIdx: i }
  }
  return null
}

/**
 * Extract the agent's response table (| # | Action | Detail |) that follows
 * the advisor review. Returns null when missing or no advisor review precedes.
 */
export function extractAgentResponseTable(history, sinceIdx) {
  const entries = Array.isArray(history) ? history : []
  for (let i = sinceIdx ?? 0; i < entries.length; i++) {
    const m = entries[i]
    if (m.role !== "assistant" || typeof m.content !== "string") continue
    if (m.content.includes(AGENT_RESPONSE_HEADER)) return m.content
  }
  return null
}

/**
 * Load review criteria: project .thincoder/advisor.md if present,
 * otherwise the built-in defaults.
 */
export function loadAdvisorMd(cwd) {
  try {
    return readFileSync(join(cwd, ADVISOR_MD_PATH), "utf8")
  } catch {
    return DEFAULT_CRITERIA
  }
}

/** Extract recent user↔assistant exchanges (up to maxTurns) for intent context. */
export function extractConversationBackground(history, maxTurns = 3) {
  const entries = Array.isArray(history) ? history : []
  const lines = []
  let turns = 0
  for (let i = entries.length - 1; i >= 0 && turns < maxTurns; i--) {
    const m = entries[i]
    if (m.role === "tool" || m.role === "system") continue
    if (typeof m.content !== "string") continue
    if (m.content.startsWith("[System reminder:") || m.content.startsWith("[Relevant memories")) continue
    if (m.role === "user" || m.role === "assistant") {
      lines.unshift(`${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 400)}`)
      if (m.role === "user") turns++
    }
  }
  return lines.length > 0 ? lines.join("\n\n") : null
}

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
  // Design review: dedicated prompt, no convergence rounds
  if (reviewType === "design") return ADVISOR_DESIGN || `You are an independent design reviewer for an engineering-mode project. Review the design document in the changes below. Evaluate: completeness, feasibility, clarity, scope, acceptance criteria. Read METHODOLOGY.md if provided. Produce a review table with | # | Category | Severity | Issue | Suggestion | format.`
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  if (!prior || (agent._advisorRound || 0) === 0) return ADVISOR_ROUND1
  const round = (agent._advisorRound || 0) + 1
  if (round === 2) return ADVISOR_ROUND2
  return ADVISOR_ROUND3
}

// ────────────────────────────────────────
// User message building
// ────────────────────────────────────────

/**
 * Build the user message for an advisor review session.
 * @param {Object} agent — the parent agent
 * @param {Object|null} [_prior] — prior issue table
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — token injected into the design-review prompt; the advisor echoes it only on approval
 * @returns {string} the user message
 */
export function buildAdvisorUserMessage(agent, _prior, reviewType, designToken = null) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)

  // Repos to review
  const repos = findReviewRepos(agent)
  const repoList = repos.length > 0
    ? repos.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : `(no git repository — working directory: ${agent.cwd})`

  const parts = []

  // Design review: simplified message — focus on the design doc, not code
  if (reviewType === "design") {
    parts.push("## Design Review")
    parts.push("The following changes are a design document. Review it against the project's methodology.")
    parts.push("")

    // List changed file paths explicitly — new design docs are untracked,
    // so git diff HEAD won't show their content; the advisor must read the file itself
    const changedFiles = collectChangedFiles(repos, agent.cwd)
    if (changedFiles.length > 0) {
      parts.push("## Changed Files")
      parts.push(changedFiles.map((f) => `- ${f}`).join("\n"))
      parts.push("")
      parts.push("Read each changed file in full — untracked files are not shown in the diff below.")
      parts.push("")
    }

    // Pre-collected changes — the design doc diff.
    // _advisorLastSnapshot is only consumed by code-review convergence — skip the write here.
    const snapshots = collectRepoSnapshots(repos, agent.cwd)
    if (snapshots.length > 0) {
      parts.push("## Design Document (git diff)")
      parts.push(...snapshots)
      parts.push("")
    }

    // Engineering mode: inject project methodology
    if (agent.config?.agent?.engineering) {
      try {
        const mpath = resolve(agent.cwd, "METHODOLOGY.md")
        const methodology = readFileSync(mpath, "utf8")
        parts.push("## Project Methodology")
        parts.push("Evaluate the design against this methodology:")
        parts.push(methodology)
        parts.push("")
      } catch { /* file doesn't exist — skip */ }
    }

    parts.push("## Instructions")
    parts.push("1. Read the design document fully. Read METHODOLOGY.md to understand the project's standards.")
    parts.push("2. Review against: completeness (all requirements covered?), feasibility (can this be built?), clarity (specific enough?), acceptance criteria (verifiable?), scope (appropriate?).")
    parts.push("3. Do NOT run git diff or look for code changes — there are none at this stage.")
    parts.push("4. If you find issues, produce your review table with the format: | # | Category | Severity | Issue | Suggestion |. If the design passes, no table is needed.")
    if (designToken) {
      parts.push("")
      parts.push("## Approval Signal")
      parts.push(`If — and ONLY if — your review finds NO 🔴 (Critical) issues, end your reply with this exact token: [DESIGN-TOKEN:${designToken}]`)
      parts.push("🟡 (Advisory) and 🔵 (Note) findings do NOT block approval — list them if present, but still include the token. If there are any 🔴 issues, do NOT include the token.")
    }
    return parts.join("\n")
  }

  // Convergence data (round 2+)
  if (prior && (agent._advisorRound || 0) > 0) {
    const response = extractAgentResponseTable(agent.history, prior.sinceIdx)
      || "(Agent did not provide a response table — re-evaluate each issue)"
    const round = (agent._advisorRound || 0) + 1
    const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"
    parts.push(`## Round ${round} — ${label}`)
    parts.push("")
    parts.push("## Prior Issue Table")
    parts.push(prior.text)
    parts.push("")
    parts.push("## Agent Response")
    parts.push(response)
    parts.push("")
    parts.push("---")
    parts.push("")
  }

  // Review scope
  parts.push("## Review Scope")
  parts.push(`Review the following git repositor${repos.length === 1 ? "y" : "ies"}:`)
  parts.push(repoList)
  parts.push("")

  // Pre-collected changes — saves the advisor from spending its first tool
  // calls on discovery (git status / git diff) every single round.
  const snapshots = collectRepoSnapshots(repos, agent.cwd)
  agent._advisorLastSnapshot = snapshots.join("\n") // dedup baseline for follow-up rounds
  if (snapshots.length > 0) {
    parts.push("## Current Changes (git status + git diff HEAD, pre-collected)")
    parts.push(...snapshots)
    parts.push("")
  }

  // Conversation background — recent user↔assistant exchanges for intent context
  const background = extractConversationBackground(agent.history)
  if (background) {
    parts.push("## Conversation Background (recent turns)")
    parts.push(background)
    parts.push("")
  }

  // Review criteria
  const criteria = loadAdvisorMd(agent.cwd)
  parts.push("## Review Criteria")
  parts.push(criteria)
  parts.push("")

  // Engineering mode: inject project methodology so advisor knows the rules
  if (agent.config?.agent?.engineering) {
    try {
      const mpath = resolve(agent.cwd, "METHODOLOGY.md")
      const methodology = readFileSync(mpath, "utf8")
      parts.push("## Project Methodology (Engineering Mode)")
      parts.push("The project follows this methodology. Evaluate the changes against it:")
      parts.push(methodology)
      parts.push("")
    } catch { /* file doesn't exist — skip */ }
  }

  // Instructions — round-aware: re-reviews skip convention discovery entirely
  const isReReview = prior && (agent._advisorRound || 0) > 0
  parts.push("## Instructions")
  parts.push("1. The uncommitted changes are already provided above — do NOT re-run `git status` / `git diff` unless the embedded diff is marked truncated.")
  if (isReReview) {
    parts.push("2. Do NOT re-read AGENTS.md / design docs — conventions were established in round 1. Focus on verifying the prior issue table against the current diff.")
    parts.push("3. `read` only the files touched by the fixes. Batch independent reads/greps in a single reply.")
    parts.push("4. Produce your verification table. Do not re-read content you already have.")
  } else {
    parts.push("2. Read `AGENTS.md` / design docs only if they exist (check once; do not re-probe with multiple patterns).")
    parts.push("3. `read` changed files for full context beyond the diff. Batch independent reads/greps in a single reply instead of one call per round-trip.")
    parts.push("4. Use `grep` or `lsp` to trace callers, imports, and dependencies — only where the diff leaves genuine doubt.")
    parts.push("5. Produce your review table based on the review criteria above. Do not re-read content you already have.")
    parts.push("6. You may also flag other issues: crashes, data loss, logic errors — anything obvious. This is the convergence protocol: round 1 is the full review, later rounds only re-verify.")
  }
  parts.push("")
  parts.push("Return your review as a markdown table (or a clear statement that everything is fine).")

  return parts.join("\n")
}

/**
 * Build a follow-up user message for round 2+ — the agent's response table +
 * the refreshed diff, without re-sending the full round-1 context.
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
    "## Prior Issue Table",
    prior?.text ?? "(no prior table — review from scratch)",
    "",
    "## Agent Response",
    response,
    "",
    "## Instructions",
    round === 2
      ? "Verify each item in the prior table. Flag any obvious NEW issues introduced by the fixes (crashes, data loss, logic errors — not style). Produce a verification table."
      : "Strictly verify ONLY the items in the prior table against the current diff. Do NOT look for new issues.",
    "",
    "Do NOT re-read AGENTS.md / design docs or re-run git status/diff (current changes are below) — you already have full context from previous rounds.",
    "",
    "## Agent Response to Your Review",
    response,
    "",
  ]
  const snapshots = collectRepoSnapshots(findReviewRepos(agent), agent.cwd)
  const snapshotText = snapshots.join("\n")
  // Skip re-pushing an identical diff (e.g. advisor re-run without any file changes) —
  // the previous snapshot is already in the conversation, duplicating it wastes tokens.
  if (snapshotText && snapshotText === agent._advisorLastSnapshot) {
    parts.push("## Current Changes", "(No changes since your previous review.)")
  } else if (snapshots.length > 0) {
    parts.push("## Current Changes (git status + git diff HEAD, refreshed)", ...snapshots)
  }
  agent._advisorLastSnapshot = snapshotText
  return parts.join("\n")
}

/**
 * Build or continue the advisor conversation for this run.
 * First call in a run: fresh [system, user] session. Later calls: append a
 * follow-up to the existing session so the advisor keeps its context.
 * After an app restart (session lost), falls back to a fresh session whose
 * system prompt is picked from history tables (round 2/3 style).
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — design-review approval token (design only)
 */
export function prepareAdvisorMessages(agent, reviewType, designToken = null) {
  const prior = extractPriorIssueTable(agent.history)
  // Design review: always fresh session, no convergence
  if (reviewType === "design") {
    return [
      { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
      { role: "user", content: buildAdvisorUserMessage(agent, prior, reviewType, designToken) },
    ]
  }
  let session = agent._advisorSession
  if (session) {
    // Session exists but no prior table (last review was all-clear or none) —
    // a follow-up "Verify Prior Table" would be meaningless; start a fresh full review
    if (!prior) {
      agent._advisorRound = 0
      agent._advisorSession = null
      session = null
    } else {
      session.push({ role: "user", content: buildAdvisorFollowUp(agent, prior) })
      return session
    }
  }
  session = [
    { role: "system", content: buildAdvisorSystemPrompt(agent, prior, reviewType) },
    { role: "user", content: buildAdvisorUserMessage(agent, prior, reviewType, designToken) },
  ]
  // Fresh session with no prior issue table → reset convergence round
  if (!prior) agent._advisorRound = 0
  return session
}
