/**
 * advisor.mjs — Code review engine.
 * Called by the advisor tool (agent-tools/advisor.mjs) when the agent
 * explicitly requests a review at the end of a coding task.
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
 *
 * Project customisation: .thincoder/advisor.md in the project root.
 */
import { chat } from "./provider/core.mjs"
import { findProvider } from "./config.mjs"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { toOpenAISchema } from "./tools/index.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const ADVISOR_MD_PATH = ".thincoder/advisor.md"
const GIT_TIMEOUT = 5_000

const DEFAULT_CRITERIA = `Review the code changes, focusing on:
1. Correctness: logic errors, edge cases, off-by-one, incomplete modifications
2. Security: unhandled exceptions, null references, resource leaks, race conditions
3. Consistency: alignment with existing project patterns and conventions
4. Completeness: missing callers, imports, or follow-up changes
5. Maintainability: vague naming, missing comments, overly complex logic`

// ────────────────────────────────────────
// Advisor's read-only tool set
// ────────────────────────────────────────

/**
 * Restricted git tool: diff / status / log only.
 * Checkpoint create/rewind are blocked — the advisor must not mutate state.
 */
const { gitTool, readTool, globTool, grepTool, lsTool } = await import("./tools/index.mjs")
const { lspTool } = await import("./tools/lsp.mjs")
const { codeModeTool: codeSearchTool } = await import("./tools/codemode.mjs")

const advisorGitTool = {
  ...gitTool,
  readonly: true,
  async execute(args, ctx) {
    // Block checkpoint create/rewind — advisor is read-only
    if (args.action === "checkpoint") {
      if (args.checkpointAction === "create" || args.checkpointAction === "rewind") {
        return "Error: checkpoint create/rewind is disabled in advisor mode. Use diff/status/log only."
      }
    }
    return gitTool.execute(args, ctx)
  },
}

const ADVISOR_TOOLS = [readTool, globTool, grepTool, lsTool, advisorGitTool, lspTool, codeSearchTool]
const ADVISOR_TOOL_SCHEMAS = ADVISOR_TOOLS.map(toOpenAISchema)
const ADVISOR_TOOL_BY_NAME = new Map(ADVISOR_TOOLS.map((t) => [t.name, t]))

// ────────────────────────────────────────
// Prompt files — loaded at module init
// ────────────────────────────────────────

const ADVISOR_ROUND1 = readFileSync(join(__dirname, "prompts", "advisor-round1.md"), "utf8")
const ADVISOR_ROUND2 = readFileSync(join(__dirname, "prompts", "advisor-round2.md"), "utf8")
const ADVISOR_ROUND3 = readFileSync(join(__dirname, "prompts", "advisor-round3.md"), "utf8")

// ────────────────────────────────────────
// History extraction — issue/response tables
// ────────────────────────────────────────

const ADVISOR_TABLE_HEADER = "| # | File | Severity | Issue | Suggestion |"
const CONVERGENCE_TABLE_HEADER = "| # | Orig# | File | Severity | Status | Notes |"
const AGENT_RESPONSE_HEADER = "| # | Action | Detail |"
const LEGACY_ADVISOR_HEADER = "| # | 文件 | 严重程度 | 问题描述 | 建议修复 |"
const LEGACY_CONVERGENCE_HEADER = "| # | 原# | 文件 | 严重程度 | 当前状态 | 说明 |"
const LEGACY_RESPONSE_HEADER = "| # | 处理 | 详情 |"
const ALL_CLEAR_PHRASES = [
  "No issues found",
  "All issues resolved",
  "review passed",
  "未发现问题",
  "所有问题已解决",
  "审查通过",
]

export function extractPriorIssueTable(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== "tool") continue
    const content = typeof m.content === "string" ? m.content : ""
    if (ALL_CLEAR_PHRASES.some((p) => content.includes(p))) return null
    if (content.includes(ADVISOR_TABLE_HEADER) || content.includes(CONVERGENCE_TABLE_HEADER) ||
        content.includes(LEGACY_ADVISOR_HEADER) || content.includes(LEGACY_CONVERGENCE_HEADER)) {
      const table = extractTableBlock(content)
      if (table) return { text: table, sinceIdx: i }
      return null
    }
  }
  return null
}

export function extractAgentResponseTable(history, sinceIdx) {
  for (let i = sinceIdx + 1; i < history.length; i++) {
    const m = history[i]
    if (m.role !== "assistant") continue
    const content = typeof m.content === "string" ? m.content : ""
    if (content.includes(AGENT_RESPONSE_HEADER) || content.includes(LEGACY_RESPONSE_HEADER)) {
      return extractTableBlock(content)
    }
  }
  return null
}

function extractTableBlock(text) {
  const lines = text.split("\n")
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("|")) { start = i; break }
  }
  if (start < 0) return null
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("|")) end = i
    else break
  }
  return lines.slice(start, end + 1).join("\n")
}

// ────────────────────────────────────────
// Review scope — repos to review
// ────────────────────────────────────────

/**
 * Find the git repository roots that contain the agent's touched files.
 * Falls back to cwd if no repos found.
 */
function findReviewRepos(agent) {
  const touched = agent._touchedFiles ?? []
  const repos = []

  for (const abs of touched) {
    try {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dirname(abs), encoding: "utf8", timeout: GIT_TIMEOUT,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      if (root && !repos.includes(root)) repos.push(root)
    } catch { /* not a git repo */ }
  }

  if (repos.length > 0) return repos

  // Fallback: cwd itself
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: agent.cwd, encoding: "utf8", timeout: GIT_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (root) return [root]
  } catch { /* not a git repo */ }

  return []
}

// ────────────────────────────────────────

/** Cap per-repo embedded diff — generous (large-context models); advisor can fetch the rest via its git tool */
const MAX_EMBEDDED_DIFF = 50_000

/**
 * Collect git status + diff for each repo, embedded into the review context so
 * the advisor doesn't need to spend its first tool calls discovering changes.
 */
function collectRepoSnapshots(repos, cwd) {
  const targets = repos.length > 0 ? repos : [cwd]
  const parts = []
  for (const repo of targets) {
    let status = "", diff = ""
    try {
      status = execFileSync("git", ["status", "--porcelain"], {
        cwd: repo, encoding: "utf8", timeout: GIT_TIMEOUT, stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      diff = execFileSync("git", ["diff", "HEAD"], {
        cwd: repo, encoding: "utf8", timeout: GIT_TIMEOUT, stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
      })
    } catch { continue /* not a git repo or git failed */ }
    if (!status && !diff.trim()) continue
    parts.push(`### ${repo}`)
    if (status) parts.push("```", status, "```")
    if (diff.trim()) {
      const truncated = diff.length > MAX_EMBEDDED_DIFF
      parts.push("```diff", truncated ? diff.slice(0, MAX_EMBEDDED_DIFF) : diff.trimEnd(), "```")
      if (truncated) parts.push(`(diff truncated at ${MAX_EMBEDDED_DIFF} chars — use the git tool to see the rest)`)
    }
  }
  return parts
}

export function loadAdvisorMd(cwd) {
  const path = join(cwd, ADVISOR_MD_PATH)
  if (!existsSync(path)) return DEFAULT_CRITERIA
  try {
    const content = readFileSync(path, "utf8").trim()
    return content || DEFAULT_CRITERIA
  } catch {
    return DEFAULT_CRITERIA
  }
}

const MAX_BACKGROUND_CHARS = 20_000
const MAX_BG_USER_CHARS = 2000
const MAX_BG_ASSISTANT_CHARS = 1500

/**
 * Recent conversation context for the advisor: the last few user↔assistant
 * exchanges (default 3 user turns). The last user message alone often lacks
 * context ("把那个问题改一下" means nothing without the preceding turns) —
 * the advisor needs the background to judge whether the changes match intent.
 * Tool messages are skipped (noise); texts are truncated with generous caps
 * (models have large context windows — completeness beats frugality).
 */
export function extractConversationBackground(history, maxTurns = 3) {
  const isNoise = (c) => c.startsWith("[System reminder:") || c.startsWith("[User interrupt:")
  const picked = []
  let userCount = 0
  for (let i = history.length - 1; i >= 0 && userCount < maxTurns; i--) {
    const m = history[i]
    if (m.role !== "user" && m.role !== "assistant") continue
    const content = typeof m.content === "string" ? m.content.trim() : ""
    if (!content || isNoise(content)) continue
    picked.unshift({ role: m.role === "user" ? "User" : "Assistant", text: content })
    if (m.role === "user") userCount++
  }
  if (picked.length === 0) return null

  const lines = picked.map((e) => {
    const cap = e.role === "User" ? MAX_BG_USER_CHARS : MAX_BG_ASSISTANT_CHARS
    const text = e.text.length > cap ? e.text.slice(0, cap) + "…" : e.text
    return `${e.role}: ${text}`
  })
  // Keep the most recent lines within the total budget
  const out = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length > 0 && total + lines[i].length > MAX_BACKGROUND_CHARS) break
    total += lines[i].length
    out.unshift(lines[i])
  }
  return out.join("\n")
}

// ────────────────────────────────────────
// System prompt routing
// ────────────────────────────────────────

export function buildAdvisorSystemPrompt(agent, _prior) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  if (!prior || (agent._advisorRound || 0) === 0) return ADVISOR_ROUND1
  const round = (agent._advisorRound || 0) + 1
  if (round === 2) return ADVISOR_ROUND2
  return ADVISOR_ROUND3
}

// ────────────────────────────────────────
// User message building
// ────────────────────────────────────────

export function buildAdvisorUserMessage(agent, _prior) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)

  // Repos to review
  const repos = findReviewRepos(agent)
  const repoList = repos.length > 0
    ? repos.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : `(no git repository — working directory: ${agent.cwd})`

  const parts = []

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
  }
  parts.push("Do NOT flag features that are valid under the project's stated platform requirements.")

  return parts.join("\n")
}

// ────────────────────────────────────────
// Session continuity — one advisor conversation per run
// ────────────────────────────────────────

/**
 * Follow-up message for round 2+ in a continued advisor session.
 * The advisor already has full context (its exploration, its issue table) in
 * the conversation — the follow-up only carries what changed: the agent's
 * response table, the fresh diff snapshot, and this round's rules.
 */
export function buildAdvisorFollowUp(agent, _prior) {
  const prior = _prior ?? extractPriorIssueTable(agent.history)
  const round = (agent._advisorRound || 0) + 1
  const response = (prior ? extractAgentResponseTable(agent.history, prior.sinceIdx) : null)
    || "(Agent did not provide a response table — re-evaluate each issue)"
  const rules = round === 2
    ? "Verify each item in your prior issue table against the current changes. " +
      "You may flag obvious NEW issues introduced by the fixes — but only crashes, data loss, or logic errors clearly visible in the diff. Do not nitpick style."
    : "Strictly verify only your prior issue table against the current changes. Do NOT look for new issues."

  const parts = [
    `## Round ${round} — ${round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"}`,
    "",
    rules,
    "",
    'If every prior issue is resolved, say exactly: "All issues resolved — review passed."',
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
 */
export function prepareAdvisorMessages(agent) {
  const prior = extractPriorIssueTable(agent.history)
  let session = agent._advisorSession
  if (session) {
    session.push({ role: "user", content: buildAdvisorFollowUp(agent, prior) })
    return session
  }
  session = [
    { role: "system", content: buildAdvisorSystemPrompt(agent, prior) },
    { role: "user", content: buildAdvisorUserMessage(agent, prior) },
  ]
  return session
}

// ────────────────────────────────────────
// Advisor tool loop
// ────────────────────────────────────────

/**
 * Compact one-line summary of tool args for panel progress lines.
 * Picks the most identifying field; falls back to truncated JSON.
 */
function summarizeToolArgs(args) {
  // e.g. "git diff HEAD", "read src/x.mjs" — action first when present
  const parts = [args.action, args.path ?? args.pattern ?? args.command].filter((v) => v != null)
  let s = parts.length > 0 ? parts.map(String).join(" ") : JSON.stringify(args)
  s = s.replace(/\s+/g, " ").trim()
  return s.length > 80 ? s.slice(0, 79) + "…" : s
}

/**
 * Run the advisor's tool loop: chat → execute tools → repeat.
 * Stops when the model produces text without tool calls.
 *
 * Progress lines (→ tool args) are emitted via onOutput between model bursts so
 * the panel keeps moving while the advisor explores — otherwise the panel sits
 * frozen through every tool-call phase and the review appears to have stalled.
 */
async function runAdvisorToolLoop(provider, messages, onOutput, signal, agent, cwd) {
  // Kind-tagged wrappers: the TUI panel colors reasoning / answer / tool progress differently.
  const emit = (kind) => (onOutput ? (text) => onOutput({ kind, text }) : undefined)
  const onThink = emit("think")
  const onText = emit("text")
  while (true) {
    const response = await chat(provider, {
      messages,
      tools: ADVISOR_TOOL_SCHEMAS,
      signal: (signal && !signal.aborted) ? signal : new AbortController().signal,
      onToken: onText,
      onReasoning: onThink,
    })

    // No tool calls — this is the final review text
    if (!response.toolCalls?.length) {
      if (!response.content?.trim()) return "Advisor: (empty response — review was inconclusive)"
      return response.content.trim()
    }

    // Push assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id, type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute each tool call
    for (const tc of response.toolCalls) {
      const tool = ADVISOR_TOOL_BY_NAME.get(tc.name)
      let args = {}
      try { args = JSON.parse(tc.arguments || "{}") } catch { /* summarized as raw JSON below */ }
      onOutput?.({ kind: "tool", text: `\n→ ${tc.name} ${summarizeToolArgs(args)}\n` })
      let result
      if (!tool) {
        result = `Error: unknown tool "${tc.name}". Available: ${[...ADVISOR_TOOL_BY_NAME.keys()].join(", ")}`
      } else {
        try {
          result = await tool.execute(args, {
            cwd,
            agent,
            onOutput,
            signal,
          })
        } catch (e) {
          result = `Error: ${e.message}`
        }
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) })
    }
  }
}

// ────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────

export function resolveAdvisorProvider(agent) {
  const cfg = agent.config?.advisor
  if (cfg?.provider) {
    try {
      const provider = findProvider(agent.providers ?? [agent.provider], cfg.provider)
      const result = cfg.model ? { ...provider, model: cfg.model } : { ...provider }
      if (cfg.thinking === null) result.thinking = undefined  // explicitly off
      else if (cfg.thinking !== undefined) result.thinking = cfg.thinking
      if (cfg.reasoningEffort !== undefined) result.reasoningEffort = cfg.reasoningEffort
      return result
    } catch {
      // Provider not found — fall back to main provider
    }
  }
  const provider = { ...agent.provider }
  if (cfg?.model) provider.model = cfg.model
  if (cfg?.thinking === null) provider.thinking = undefined  // explicitly off
  else if (cfg?.thinking !== undefined) provider.thinking = cfg.thinking
  if (cfg?.reasoningEffort !== undefined) provider.reasoningEffort = cfg.reasoningEffort
  return provider
}

/**
 * Whether every changed file across the review repos is documentation-only.
 * Used to skip pointless code reviews for doc updates (README, docs/, LICENSE…).
 */
function isDocOnlyChange(repos, cwd) {
  const DOC_FILE = /(?:^|[/\\])(?:LICENSE|NOTICE|CHANGELOG|AUTHORS)(?:\.\w+)?$|\.(?:md|markdown|mdx|txt|rst|adoc)$/i
  const targets = repos.length > 0 ? repos : [cwd]
  let sawChanges = false
  for (const repo of targets) {
    let status = ""
    try {
      status = execFileSync("git", ["status", "--porcelain"], {
        cwd: repo, encoding: "utf8", timeout: GIT_TIMEOUT, stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch { return false /* can't tell — let the advisor run */ }
    if (!status) continue
    sawChanges = true
    for (const line of status.split("\n")) {
      // porcelain: "XY path" or "XY old -> new" (rename)
      const filePath = line.slice(3).split(" -> ").pop().replace(/^"|"$/g, "")
      if (!DOC_FILE.test(filePath)) return false
    }
  }
  return sawChanges
}

export async function runAdvisorReview(agent, onOutput, signal) {
  const cfg = agent.config?.advisor
  // Engineering mode overrides advisor toggle — reviews are mandatory regardless
  if (!cfg?.enabled && !agent.config?.agent?.engineering) return null

  // Engineering mode: subagent (eng-coder) may have made all the changes,
  // so parent's _touchedFiles can be empty — let git diff discover changes
  if (!agent.config?.agent?.engineering && (agent._touchedFiles ?? []).length === 0) return null

  const repos = findReviewRepos(agent)

  // Fast path: documentation-only changes need no code review — unless the project
  // customized review criteria (.thincoder/advisor.md may genuinely care about docs).
  if (!existsSync(join(agent.cwd, ADVISOR_MD_PATH)) && isDocOnlyChange(repos, agent.cwd)) {
    return "No issues found — documentation-only changes, code review skipped."
  }

  const provider = resolveAdvisorProvider(agent)

  // Set the advisor's cwd to the first repo (for tool context)
  const advisorCwd = repos.length > 0 ? repos[0] : agent.cwd

  const messages = prepareAdvisorMessages(agent)

  try {
    const result = await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)
    // Persist the conversation: the next advisor call in this run continues here
    // (reset by runAgent when the run ends — each task gets a fresh advisor session)
    agent._advisorSession = messages
    return result
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e
    return `Advisor: review failed — ${e.message || "unknown error"}. You may retry or proceed to verify.`
  }
}
