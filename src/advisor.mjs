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
 *   Hard cap: MAX_ADVISOR_ROUNDS (5) total advisor calls per runAgent.
 *
 * Project customisation: .thincoder/advisor.md in the project root.
 */
import { chat } from "./provider/core.mjs"
import { findProvider } from "./config.mjs"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { toOpenAISchema } from "./tools/index.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const ADVISOR_MD_PATH = ".thincoder/advisor.md"
const MAX_TASK_SUMMARY = 500
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

function extractTaskSummary(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== "user") continue
    const content = typeof m.content === "string" ? m.content : ""
    if (content.startsWith("[System reminder:") || content.startsWith("[User interrupt:")) continue
    const firstPara = content.split("\n\n")[0]
    return firstPara.length > MAX_TASK_SUMMARY ? firstPara.slice(0, MAX_TASK_SUMMARY) + "…" : firstPara
  }
  return null
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

  // Task summary
  const taskSummary = extractTaskSummary(agent.history)
  if (taskSummary) {
    parts.push("## Task")
    parts.push(taskSummary)
    parts.push("")
  }

  // Review criteria
  const criteria = loadAdvisorMd(agent.cwd)
  parts.push("## Review Criteria")
  parts.push(criteria)
  parts.push("")

  // Instructions
  parts.push("## Instructions")
  parts.push("1. Read `AGENTS.md` and any design documents first — understand project conventions, version requirements, and architecture decisions before flagging issues.")
  parts.push("2. Run `git diff HEAD` in each repo to discover uncommitted changes.")
  parts.push("3. `read` changed files for full context beyond the diff.")
  parts.push("4. Use `grep` or `lsp` to trace callers, imports, and dependencies.")
  parts.push("5. Produce your review table based on the review criteria above.")
  parts.push("Do NOT flag features that are valid under the project's stated platform requirements.")

  return parts.join("\n")
}

// ────────────────────────────────────────
// Advisor tool loop
// ────────────────────────────────────────

/**
 * Run the advisor's tool loop: chat → execute tools → repeat.
 * Stops when the model produces text without tool calls.
 */
async function runAdvisorToolLoop(provider, messages, onOutput, signal, agent, cwd) {
  while (true) {
    const response = await chat(provider, {
      messages,
      tools: ADVISOR_TOOL_SCHEMAS,
      signal: (signal && !signal.aborted) ? signal : new AbortController().signal,
      onToken: onOutput,
      onReasoning: onOutput,
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
      let result
      if (!tool) {
        result = `Error: unknown tool "${tc.name}". Available: ${[...ADVISOR_TOOL_BY_NAME.keys()].join(", ")}`
      } else {
        try {
          const args = JSON.parse(tc.arguments || "{}")
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
      return cfg.model ? { ...provider, model: cfg.model } : provider
    } catch {
      // Provider not found — fall back to main provider
    }
  }
  const provider = { ...agent.provider }
  if (cfg?.model) provider.model = cfg.model
  return provider
}

export async function runAdvisorReview(agent, onOutput, signal) {
  const cfg = agent.config?.advisor
  if (!cfg?.enabled) return null

  const repos = findReviewRepos(agent)
  if ((agent._touchedFiles ?? []).length === 0) return null

  const provider = resolveAdvisorProvider(agent)
  const priorIssue = extractPriorIssueTable(agent.history)
  const systemPrompt = buildAdvisorSystemPrompt(agent, priorIssue)
  const userMessage = buildAdvisorUserMessage(agent, priorIssue)

  // Set the advisor's cwd to the first repo (for tool context)
  const advisorCwd = repos.length > 0 ? repos[0] : agent.cwd

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]

  try {
    return await runAdvisorToolLoop(provider, messages, onOutput, signal, agent, advisorCwd)
  } catch (e) {
    if (e.name === "AbortError" && signal?.reason?.interrupt) throw e
    return `Advisor: review failed — ${e.message || "unknown error"}. You may retry or proceed to verify.`
  }
}
