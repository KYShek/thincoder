/**
 * advisor/messages.mjs — advisor user-message building (buildAdvisorUserMessage).
 * Split out of advisor.mjs to keep it under the 300-line advisory threshold
 * (.thincoder/advisor.md). System prompts live in advisor.mjs / prompts/.
 */
import { readFileSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { specForModel } from "../config.mjs"
import { findReviewRepos, collectRepoSnapshots, collectChangedFiles } from "./repos.mjs"
import { loadAdvisorMd, extractConversationBackground, extractAgentResponseTable, extractPriorIssueTable } from "./history.mjs"

/** Project guide (AGENTS.md) injection budget — decision 2026-08-08:
 *  NO fixed truncation; long-context models (1M+) get up to 5% of their context
 *  window for the doc map, small windows still get a floor so the map is always
 *  visible. The map is what tells the reviewer WHERE the requirements docs live
 *  (requirement-fit is judged against those docs, not the conversation only). */
const PROJECT_GUIDE_MIN = 8192 // chars — floor for small-window models
const PROJECT_GUIDE_FRACTION = 0.05 // 5% of the reviewer model's context window

/**
 * Inject the project guide (AGENTS.md) into the review message. AGENTS.md is the
 * project's doc map — it defines the structure and where requirements/design
 * documents live. The reviewer must see it FIRST: requirement-fit is judged
 * against the documents it points to, with the conversation background as a
 * supplement. Absent AGENTS.md degrades honestly (no pretending there is a map).
 */
function injectProjectGuide(agent, parts) {
  const path = resolve(agent.cwd, "AGENTS.md")
  parts.push("## Project Guide (AGENTS.md)")
  try {
    const text = readFileSync(path, "utf8")
    const ctx = specForModel(agent.provider?.model ?? "").context
    const cap = Math.max(PROJECT_GUIDE_MIN, Math.floor(ctx * PROJECT_GUIDE_FRACTION))
    const shown = text.length <= cap
      ? text
      : text.slice(0, cap) + `\n\n…(truncated at ${cap} chars — read the full file if you need more)`
    parts.push("This file defines the project's structure and where its requirements/design documents live. Read the documents it points to — the user's requirements live THERE, not only in the conversation background.")
    parts.push("")
    parts.push(shown)
    return true // guide injected — requirement-fit criteria apply
  } catch {
    parts.push("(No AGENTS.md found at the project root — judge the user's requirements from the conversation background, and say so explicitly if the requirements are unclear.)")
  }
  parts.push("")
  return false // no guide — requirement-fit falls back to the conversation
}

/**
 * Build the user message for an advisor review session.
 * @param {Object} agent — the parent agent
 * @param {Object|null} [prior] — prior issue table
 * @param {string} [reviewType] — "design" or "code" (default)
 * @param {string|null} [designToken] — token injected into the design-review prompt; the advisor echoes it only on approval
 * @param {string[]|null} [documents] — design review only: explicit list of doc paths to review (requirements + design + referenced docs).
 *   When set, the review input is built from this list ONLY — no git-diff change-set collection.
 *   When absent, the legacy git-diff-based scope is kept (backward compatible).
 * @param {string[]|null} [paths] — code review only: explicit list of file/dir paths to review (deduped; shown under Review Scope)
 * @returns {string} the user message
 */
export function buildAdvisorUserMessage(agent, prior, reviewType, designToken = null, documents = null, paths = null) {
  const p = prior ?? extractPriorIssueTable(agent.history)

  const parts = []
  const docList = Array.isArray(documents) ? documents.filter((d) => typeof d === "string" && d.trim()) : []
  const pathList = Array.isArray(paths) ? [...new Set(paths.filter((p) => typeof p === "string" && p.trim()))] : []

  // Project guide FIRST in EVERY review path (code AND design round 0): the map
  // to the requirements docs is needed for design reviews too (design must fit
  // the requirements, not just the methodology). Design round 0 early-returns
  // below — the guide must be injected before that return.
  const guideInjected = injectProjectGuide(agent, parts)

  // Design review: simplified message — focus on the design doc, not code
  if (reviewType === "design" && (agent._advisorRound || 0) === 0) {
    const repos = findReviewRepos(agent)
    parts.push("## Design Review")
    if (docList.length > 0) {
      // Explicit review scope (engineering mode, FR2): the caller hands over the
      // doc list — the advisor reviews ONLY these. No git-diff change-set
      // collection: diff-based discovery reviewed unrelated files, and untracked
      // design docs were invisible to git diff anyway (ENGINEERING-MODE.md §2.4).
      parts.push("The documents below are the review scope. Review ONLY these files — do not scan git diff or read any other files.")
      parts.push("")
      parts.push("## Documents to Review")
      parts.push(docList.map((d) => `- ${d} — Read this file in full`).join("\n"))
      parts.push("")
    } else {
      // Backward-compatible fallback (no documents): discover docs via git status/diff.
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
      const snapshots = collectRepoSnapshots(repos, agent.cwd)
      if (snapshots.length > 0) {
        parts.push("## Design Document (git diff)")
        parts.push(...snapshots)
        parts.push("")
      }
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
    if (docList.length > 0) {
      parts.push("1. Read every document in the Documents to Review list in full — review ONLY those files. Read METHODOLOGY.md to understand the project's standards.")
    } else {
      parts.push("1. Read the design document fully. Read METHODOLOGY.md to understand the project's standards.")
    }
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

  // Convergence data (round 2+). LEGACY COMPATIBILITY PATH: the normal advisor
  // flow routes convergence rounds through buildAdvisorFollowUp (fresh session,
  // decision d698434); this block only fires for direct external callers of
  // buildAdvisorUserMessage with a prior table. Kept to avoid breaking those.
  // Same rule as buildAdvisorFollowUp: prior table IS injected (decision
  // 2026-08-05, reversed) — it is the only complete verification list.
  if (p && (agent._advisorRound || 0) > 0) {
    const scopeFiles = resolveScopeFiles(agent, paths)
    const response = extractAgentResponseTable(agent.history, p.sinceIdx)
      || (scopeFiles?.length
        ? "(Agent did not provide a response table — perform a fresh review of: " + scopeFiles.slice(0, 10).join(", ") + ")"
        : "(Agent did not provide a response table — perform a fresh review of the files named in the system prompt context)")
    const round = (agent._advisorRound || 0) + 1
    const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"
    parts.push(`## Round ${round} — ${label}`)
    parts.push("")
    parts.push("## Prior Issue Table (verify every item)")
    parts.push(p.text)
    parts.push("")
    parts.push("## Agent Response (fix claims — reference only)")
    parts.push(response)
    parts.push("")
    parts.push("---")
    parts.push("")
  }

  if (pathList.length > 0 || docList.length > 0) {
    parts.push("## Review Scope")
  }
  if (pathList.length > 0) {
    parts.push("Review these code files/directories — read them in full for context:")
    parts.push("")
    parts.push(pathList.map((p) => `- ${p}`).join("\n"))
    parts.push("")
  }
  if (docList.length > 0) {
    if (reviewType === "design") {
      parts.push("The documents below are the review scope. Review ONLY these files — do NOT scan git diff or read any other files.")
    } else {
      parts.push("The documents below define acceptance criteria and review context. Read them for context, then read the code files specified in the review scope. Judge the implementation against these documents.")
    }
    parts.push("")
    parts.push("## Documents to Review")
    parts.push(docList.map((d) => `- ${d} — Read this file in full`).join("\n"))
    parts.push("")
  }

  // Project guide — the doc map. MUST come before the conversation background:
  // requirement-fit is judged against the docs AGENTS.md points to; the recent
  // turns are only a supplement (decision 2026-08-08). Injected at the top of
  // this function so EVERY review path (code + design round 0) gets it.

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
  if (guideInjected) {
    // Requirement-fit is a first-class dimension when the project guide was
    // found — the criteria file (advisor.md) may not mention it (legacy).
    parts.push("")
    parts.push("Additional criterion: **requirement fit** — does the implementation match what the requirements documents (referenced by the Project Guide above) actually ask for?")
  }
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

  // Instructions — round-aware: re-reviews skip convention discovery entirely.
  // These are SUPPLEMENTARY reminders to the system prompt's numbered workflow —
  // deliberately not renumbered as a competing sequence.
  const isReReview = p && (agent._advisorRound || 0) > 0
  parts.push("## Instructions")
  parts.push("1. IMPORTANT: the review scope lists the files under review — always verify current file state with `read` before judging. Never decide based on earlier snapshots alone.")
  if (isReReview) {
    const round = (agent._advisorRound || 0) + 1
    parts.push(...buildConvergenceInstructions(round, pathList))
  } else {
    parts.push("2. The `## Project Guide (AGENTS.md)` section above maps the project — read the requirements/design documents it points to (they are the primary reference for requirement-fit). Use `read` to load those documents.")
    parts.push("3. `read` the files in the Review Scope in full — they define exactly what to inspect. Batch independent reads/greps in a single reply instead of one call per round-trip.")
    parts.push("4. Use `grep` or `lsp` to trace callers, imports, and dependencies — only where the diff leaves genuine doubt.")
    parts.push("5. Produce your review table based on the review criteria above. Do not re-read content you already have.")
    parts.push("6. You may also flag other issues: crashes, data loss, logic errors — anything obvious. This is the convergence protocol: round 1 is the full review, later rounds only re-verify.")
  }
  parts.push("")
  parts.push("Return your review as a markdown table (or a clear statement that everything is fine).")

  return parts.join("\n")
}

/**
 * Resolve the review surface for the convergence fallback: explicit `paths`
 * win; otherwise the runtime mutation record (_touchedFiles, ABSOLUTE) is
 * normalized to cwd-relative so the fallback list matches the relative-path
 * norm the reviewer sees everywhere else. Paths outside cwd are relativized
 * with path.relative — never a mixed absolute/relative list.
 */
export function resolveScopeFiles(agent, paths) {
  const normalize = (p) => {
    const abs = p.startsWith(agent.cwd) ? p : join(agent.cwd, p)
    return relative(agent.cwd, abs)
  }
  if (Array.isArray(paths)) return [...new Set(paths.map(normalize))]
  if (agent._touchedFiles?.length) {
    return [...new Set(agent._touchedFiles.map(normalize))]
  }
  return null
}

/**
 * Shared convergence-round instructions — single source for BOTH paths
 * (buildAdvisorUserMessage's legacy convergence block and
 * buildAdvisorFollowUp), so the wording cannot diverge.
 * Round 2 may flag obvious new issues; round 3+ is strict verification.
 * @param {number} round — convergence round number (2+)
 * @param {string[]|null} scopeFiles — optional file list for the no-response fallback
 * @returns {string[]} the numbered instruction lines (callers spread them)
 */
export function buildConvergenceInstructions(round, scopeFiles = null) {
  const fileList = scopeFiles?.length
    ? ` The review surface is: ${scopeFiles.slice(0, 10).join(", ")}.`
    : ""
  return [
    `1. IMPORTANT: verify EVERY item of the prior issue table against the CURRENT FILE STATE with \`read\` — never decide based on earlier snapshots alone.${fileList}`,
    "2. STALE-CONTEXT WARNING: any diff or file content from earlier messages is a historical snapshot — treat it as expired. Only fresh `read` results describe the current state.",
    "3. You have no git tool; git output in earlier messages is historical and untrustworthy (committed fixes never show in a diff).",
    "4. `read` the files named in the prior table (or the review surface above) in full — ALWAYS. Batch reads/greps in a single reply.",
    "5. Evidence rule: every 'Unfixed'/'New' finding MUST quote the exact line content from THIS round's `read` output (e.g. `run.mjs:180: timeoutId = setTimeout(...)`). Line numbers alone are NOT evidence — they may be stale or fabricated. Findings without a fresh quoted line are treated as unverified and will not be accepted.",
    "6. Produce your verification table. Do not re-read content you already have.",
    round === 2
      ? "7. You may flag obvious NEW issues introduced by the fixes (crashes, data loss, logic errors — not style)."
      : "7. Do NOT look for new issues.",
  ]
}

