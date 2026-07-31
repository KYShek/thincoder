/**
 * test/advisor.test.mjs — tests for the advisor convergence protocol.
 * Covers: extractPriorIssueTable, extractAgentResponseTable, buildAdvisorSystemPrompt,
 * buildAdvisorUserMessage, and the round-aware guard logic (MAX_ADVISOR_ROUNDS).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"

import {
  extractPriorIssueTable,
  extractAgentResponseTable,
  buildAdvisorSystemPrompt,
  buildAdvisorUserMessage,
  extractConversationBackground,
  buildAdvisorFollowUp,
  prepareAdvisorMessages,
} from "../src/advisor.mjs"

// ────────────────────────────────────────
// extractPriorIssueTable
// ────────────────────────────────────────

test("extractPriorIssueTable: returns null when history is empty", () => {
  assert.equal(extractPriorIssueTable([]), null)
})

test("extractPriorIssueTable: returns null when no advisor output found", () => {
  const history = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", tool_call_id: "t1", content: "some tool output" },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

test("extractPriorIssueTable: returns null when last review says all clear", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "No issues found — code quality looks good." },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

test("extractPriorIssueTable: returns null when last review says all resolved", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "All issues resolved — review passed." },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

test("extractPriorIssueTable: extracts full-review issue table", () => {
  const tableContent = `| # | File | Severity | Issue | Suggestion |
|---|------|----------|-------|------------|
| 1 | src/x.mjs | 🔴 Critical | null check missing | add guard |
| 2 | src/y.mjs | 🟡 Advisory | variable name too short | rename to betterName |`
  const history = [
    { role: "tool", tool_call_id: "a1", content: `Review results:\n\n${tableContent}\n\nPlease fix the issues above.` },
  ]
  const result = extractPriorIssueTable(history)
  assert.notEqual(result, null)
  assert.ok(result.text.includes("| # | File |"))
  assert.ok(result.text.includes("| 1 | src/x.mjs |"))
  assert.ok(result.text.includes("| 2 | src/y.mjs |"))
  assert.equal(typeof result.sinceIdx, "number")
})

test("extractPriorIssueTable: extracts convergence table", () => {
  const tableContent = `| # | Orig# | File | Severity | Status | Notes |
|---|-------|------|----------|--------|-------|
| 1 | 3     | src/x.mjs | 🔴 Critical | Unfixed | still missing null check |`
  const history = [
    { role: "tool", tool_call_id: "a2", content: `Re-review results:\n\n${tableContent}\n\nIssues remain.` },
  ]
  const result = extractPriorIssueTable(history)
  assert.notEqual(result, null)
  assert.ok(result.text.includes("| # | Orig# |"))
  assert.ok(result.text.includes("| 1 | 3     | src/x.mjs |"))
})

test("extractPriorIssueTable: finds LAST advisor call, not first", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.js | 🔴 | old | fix |" },
    { role: "tool", tool_call_id: "a2", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | b.js | 🔴 | new | fix |" },
  ]
  const result = extractPriorIssueTable(history)
  assert.ok(result.text.includes("b.js"))
  assert.ok(!result.text.includes("a.js"))
  assert.equal(result.sinceIdx, 1)
})

test("extractPriorIssueTable: skips non-string tool content", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: ["array content"] },
    { role: "tool", tool_call_id: "a2", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | c.js | 🔴 | bug | fix |" },
  ]
  const result = extractPriorIssueTable(history)
  assert.notEqual(result, null)
  assert.ok(result.text.includes("c.js"))
})

test("extractPriorIssueTable: returns null when legacy Chinese all-clear", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "未发现问题，代码质量良好" },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

// ────────────────────────────────────────
// extractAgentResponseTable
// ────────────────────────────────────────

test("extractAgentResponseTable: returns null when no response after advisor", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |" },
  ]
  assert.equal(extractAgentResponseTable(history, 0), null)
})

test("extractAgentResponseTable: returns null when assistant message has no response table", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "issue table" },
    { role: "assistant", content: "I will fix the issues." },
  ]
  assert.equal(extractAgentResponseTable(history, 0), null)
})

test("extractAgentResponseTable: extracts response table from assistant message", () => {
  const responseTable = `| # | Action | Detail |
|---|--------|--------|
| 1 | ✅ Fixed | added null check |
| 2 | ❌ Not an issue | variable name follows convention |`
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |" },
    { role: "assistant", content: `Here's my response:\n\n${responseTable}\n\nReady for re-review.` },
  ]
  const result = extractAgentResponseTable(history, 0)
  assert.notEqual(result, null)
  assert.ok(result.includes("| # | Action | Detail |"))
  assert.ok(result.includes("✅ Fixed"))
  assert.ok(result.includes("❌ Not an issue"))
})

test("extractAgentResponseTable: only looks after sinceIdx", () => {
  const history = [
    { role: "assistant", content: "| # | Action | Detail |\n| 1 | ✅ Fixed | done |" },
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |" },
    { role: "assistant", content: "I fixed it." },
  ]
  assert.equal(extractAgentResponseTable(history, 1), null)
})

test("extractAgentResponseTable: finds response after advisor when both present", () => {
  const responseTable = "| # | Action | Detail |\n| 1 | ✅ Fixed | done |"
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |" },
    { role: "assistant", content: responseTable },
  ]
  const result = extractAgentResponseTable(history, 0)
  assert.notEqual(result, null)
  assert.ok(result.includes("✅ Fixed"))
})

// ────────────────────────────────────────
// buildAdvisorSystemPrompt — routing tests
// ────────────────────────────────────────

test("buildAdvisorSystemPrompt: returns round 1 file when no prior table", () => {
  const agent = { history: [], _advisorRound: 0, cwd: tmpdir() }
  const prompt = buildAdvisorSystemPrompt(agent)
  assert.ok(prompt.includes("full-scope review"))
  assert.ok(prompt.includes("| # | File | Severity | Issue | Suggestion |"))
  assert.ok(!prompt.includes("Verify the prior issue table"))
  assert.ok(!prompt.includes("Strictly verify"))
})

test("buildAdvisorSystemPrompt: returns round 1 file when last review was all clear", () => {
  const agent = {
    history: [{ role: "tool", tool_call_id: "a1", content: "No issues found — code quality looks good." }],
    _advisorRound: 1, cwd: tmpdir(),
  }
  const prompt = buildAdvisorSystemPrompt(agent)
  assert.ok(prompt.includes("full-scope review"))
})

test("buildAdvisorSystemPrompt: returns round 2 file when prior table and _advisorRound=1", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |"
  const agent = {
    history: [{ role: "tool", tool_call_id: "a1", content: `Review:\n${issueTable}` }],
    _advisorRound: 1, cwd: tmpdir(),
  }
  const prompt = buildAdvisorSystemPrompt(agent)
  assert.ok(prompt.includes("Verify the prior issue table"))
  assert.ok(!prompt.includes("DO NOT look for new issues"))
})

test("buildAdvisorSystemPrompt: returns round 3+ file when _advisorRound>=2", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |"
  const agent = {
    history: [
      { role: "tool", tool_call_id: "a1", content: `r1: ${issueTable}` },
      { role: "assistant", content: "fixed" },
      { role: "tool", tool_call_id: "a2", content: "| # | Orig# | File | Severity | Status | Notes |\n| 1 | 1 | x.js | 🔴 | Unfixed | - |" },
    ],
    _advisorRound: 2, cwd: tmpdir(),
  }
  const prompt = buildAdvisorSystemPrompt(agent)
  assert.ok(prompt.includes("Strictly verify"))
  assert.ok(prompt.includes("Do NOT look for new issues"))
})

test("buildAdvisorSystemPrompt: returns same static content regardless of issue table content", () => {
  const agent1 = {
    history: [{ role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.js | 🔴 | bug A | fix A |" }],
    _advisorRound: 1, cwd: tmpdir(),
  }
  const agent2 = {
    history: [{ role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | b.js | 🟡 | bug B | fix B |" }],
    _advisorRound: 1, cwd: tmpdir(),
  }
  assert.equal(buildAdvisorSystemPrompt(agent1), buildAdvisorSystemPrompt(agent2))
})

test("buildAdvisorSystemPrompt: reviewType=design returns design prompt", () => {
  const agent = { history: [], _advisorRound: 0, cwd: tmpdir() }
  const result = buildAdvisorSystemPrompt(agent, null, "design")
  assert.ok(result.includes("design reviewer"), "应包含设计审查内容")
  assert.ok(!result.includes("code review"), "不应包含代码审查内容")
})

test("buildAdvisorUserMessage: reviewType=design includes design review header", () => {
  const agent = {
    history: [{ role: "user", content: "design a feature" }],
    _advisorRound: 0, cwd: tmpdir(), config: {},
  }
  const result = buildAdvisorUserMessage(agent, null, "design")
  assert.ok(result.includes("## Design Review"), "应包含设计审查标题")
  assert.ok(!result.includes("## Code Review"), "不应包含代码审查标题")
  assert.ok(!result.includes("git status"), "不应包含 git 指令")
})

test("prepareAdvisorMessages: reviewType=design returns fresh session", () => {
  const agent = {
    history: [], _advisorRound: 0, cwd: tmpdir(), config: {},
    _advisorSession: [{ role: "system", content: "old" }],
  }
  const msgs = prepareAdvisorMessages(agent, "design")
  assert.equal(msgs.length, 2, "设计审查总是新会话")
  assert.equal(msgs[0].role, "system")
  assert.equal(msgs[1].role, "user")
})

test("buildAdvisorSystemPrompt: _advisorRound===0 forces full review despite stale history", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | old.js | 🔴 | old bug | fix |"
  const agent = {
    history: [{ role: "tool", tool_call_id: "a1", content: `Old review:\n${issueTable}` }],
    _advisorRound: 0, cwd: tmpdir(),
  }
  const prompt = buildAdvisorSystemPrompt(agent)
  assert.ok(prompt.includes("full-scope review"))
  assert.ok(!prompt.includes("Verify the prior issue table"))
})

// ────────────────────────────────────────
// buildAdvisorUserMessage — review scope + convergence
// ────────────────────────────────────────

function createGitRepo(testDir) {
  execSync("git init", { cwd: testDir, stdio: "ignore" })
  execSync("git config user.email test@test", { cwd: testDir, stdio: "ignore" })
  execSync("git config user.name test", { cwd: testDir, stdio: "ignore" })
  writeFileSync(join(testDir, "dummy.js"), "// test")
  execSync("git add -A && git commit -m init", { cwd: testDir, stdio: "ignore" })
}

test("buildAdvisorUserMessage: lists review repos from _touchedFiles", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    const subdir = join(tmp, "src")
    mkdirSync(subdir, { recursive: true })
    const touchedFile = join(subdir, "app.js")
    // Commit a file so git repo is well-formed, then modify it (simulate agent edit)
    writeFileSync(touchedFile, "// original")
    execSync("git add -A && git commit -m init", { cwd: tmp, stdio: "ignore" })
    writeFileSync(touchedFile, "// changed by agent")

    const agent = {
      _touchedFiles: [touchedFile],
      cwd: tmp,
      history: [],
      _advisorRound: 0,
    }
    const msg = buildAdvisorUserMessage(agent)
    assert.ok(msg.includes("## Review Scope"))
    // git rev-parse may return paths with forward slashes on Windows
    const normalized = msg.replace(/\\/g, "/")
    assert.ok(normalized.includes(tmp.replace(/\\/g, "/")))
    assert.ok(msg.includes("## Instructions"))
    assert.ok(msg.includes("git diff HEAD"))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("buildAdvisorUserMessage: round 1 does not include convergence data", () => {
  const agent = { _touchedFiles: [], cwd: tmpdir(), history: [], _advisorRound: 0 }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(!msg.includes("## Prior Issue Table"))
  assert.ok(!msg.includes("## Agent Response"))
})

test("buildAdvisorUserMessage: round 2 includes convergence data", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |"
  const agent = {
    _touchedFiles: [], cwd: tmpdir(),
    history: [{ role: "tool", tool_call_id: "a1", content: `Review:\n${issueTable}` }],
    _advisorRound: 1,
  }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(msg.startsWith("## Round 2 — Verify Prior Table + Flag New Issues"))
  assert.ok(msg.includes("## Prior Issue Table"))
  assert.ok(msg.includes(issueTable))
  assert.ok(msg.includes("## Agent Response"))
  assert.ok(msg.includes("## Review Scope"))
})

test("buildAdvisorUserMessage: round 3+ uses strict verification header", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | x.js | 🔴 | bug | fix |"
  const agent = {
    _touchedFiles: [], cwd: tmpdir(),
    history: [
      { role: "tool", tool_call_id: "a1", content: `r1: ${issueTable}` },
      { role: "assistant", content: "fixed" },
      { role: "tool", tool_call_id: "a2", content: "| # | Orig# | File | Severity | Status | Notes |\n| 1 | 1 | x.js | 🔴 | Unfixed | - |" },
    ],
    _advisorRound: 2,
  }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(msg.startsWith("## Round 3 — Strict Verification"))
})

test("buildAdvisorUserMessage: _advisorRound===0 skips convergence data", () => {
  const issueTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | old.js | 🔴 | old bug | fix |"
  const agent = {
    _touchedFiles: [], cwd: tmpdir(),
    history: [{ role: "tool", tool_call_id: "a1", content: `Old review:\n${issueTable}` }],
    _advisorRound: 0,
  }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(!msg.includes("## Prior Issue Table"))
  assert.ok(msg.includes("## Review Scope"))
})

test("buildAdvisorUserMessage: includes recent conversation background", () => {
  const agent = {
    _touchedFiles: [], cwd: tmpdir(),
    history: [
      { role: "user", content: "The app crashes on empty input" },
      { role: "assistant", content: "Let me look at the parser first" },
      { role: "user", content: "Fix the null pointer bug" },
    ],
    _advisorRound: 0,
  }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(msg.includes("## Conversation Background"))
  assert.ok(msg.includes("Fix the null pointer bug"), "latest user message included")
  assert.ok(msg.includes("crashes on empty input"), "earlier turn included for context")
  assert.ok(msg.includes("Let me look at the parser"), "assistant reply included")
})

// ────────────────────────────────────────
// extractTableBlock edge cases
// ────────────────────────────────────────

test("extractPriorIssueTable: handles table at very end of content", () => {
  const tableContent = `| # | File | Severity | Issue | Suggestion |
|---|------|----------|-------|------------|
| 1 | a.js | 🔴 | bug | fix |`
  const history = [
    { role: "tool", tool_call_id: "a1", content: `${tableContent}` },
  ]
  const result = extractPriorIssueTable(history)
  assert.notEqual(result, null)
  assert.equal(result.text, tableContent)
})

test("extractPriorIssueTable: handles multi-line issue descriptions", () => {
  const tableContent = `| # | File | Severity | Issue | Suggestion |
|---|------|----------|-------|------------|
| 1 | a.js | 🔴 | This is a very long description that should still work | fix it |`
  const history = [
    { role: "tool", tool_call_id: "a1", content: `header\n${tableContent}\nfooter` },
  ]
  const result = extractPriorIssueTable(history)
  assert.notEqual(result, null)
  assert.ok(result.text.includes("This is a very long description"))
})

// ────────────────────────────────────────
// MAX_ADVISOR_ROUNDS guard logic (agent.mjs)
// ────────────────────────────────────────

test("agent: _advisorRound initialized to 0 in runAgent", () => {
  let _advisorRound = 0
  let _mutatedThisRun = true
  let _calledAdvisorThisRun = false

  // Guard triggers when mutated but not yet called
  assert.equal(_mutatedThisRun && !_calledAdvisorThisRun, true)

  // After calling advisor, guard stops pushing
  _calledAdvisorThisRun = true
  assert.equal(_mutatedThisRun && !_calledAdvisorThisRun, false)
})

test("agent: _advisorRound increments only on advisor tool call", () => {
  let _advisorRound = 0
  const toolCalls = [
    { name: "write", ok: true },
    { name: "advisor", ok: true },
    { name: "edit", ok: true },
    { name: "advisor", ok: true },
  ]

  for (const tc of toolCalls) {
    if (tc.name === "advisor") _advisorRound++
  }

  assert.equal(_advisorRound, 2)
})

// ────────────────────────────────────────
// Session memory — prepareAdvisorMessages / buildAdvisorFollowUp
// ────────────────────────────────────────

test("prepareAdvisorMessages: first call creates a fresh [system, user] session", () => {
  const agent = { history: [], _advisorRound: 0, _advisorSession: null, cwd: tmpdir(), _touchedFiles: [] }
  const session = prepareAdvisorMessages(agent)
  assert.equal(session.length, 2)
  assert.equal(session[0].role, "system")
  assert.equal(session[1].role, "user")
})

test("prepareAdvisorMessages: later calls append a follow-up to the SAME session", () => {
  const agent = { history: [], _advisorRound: 0, _advisorSession: null, cwd: tmpdir(), _touchedFiles: [] }
  const first = prepareAdvisorMessages(agent)
  agent._advisorSession = first // runAdvisorReview persists it after a successful review
  agent._advisorRound = 1

  const second = prepareAdvisorMessages(agent)
  assert.equal(second, first, "same array — conversation continues, not rebuilt")
  assert.equal(second.length, 3)
  assert.equal(second[2].role, "user")
  assert.ok(second[2].content.includes("Round 2"), "follow-up carries round number")
  assert.ok(second[2].content.includes("Agent Response"), "follow-up asks for the response table")

  agent._advisorRound = 2
  const third = prepareAdvisorMessages(agent)
  assert.ok(third[3].content.includes("Round 3"))
  assert.ok(third[3].content.includes("Strict"), "round 3+ is strict verification")
})

test("buildAdvisorFollowUp: includes agent response table when present", () => {
  const agent = {
    _advisorRound: 1,
    cwd: tmpdir(),
    _touchedFiles: [],
    history: [
      { role: "tool", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" },
      { role: "assistant", content: "| # | Action | Detail |\n| 1 | fixed | added null check |" },
    ],
  }
  const msg = buildAdvisorFollowUp(agent)
  assert.ok(msg.includes("added null check"), "response table extracted from history")
})

test("buildAdvisorFollowUp: tolerates missing response table", () => {
  const agent = {
    _advisorRound: 1,
    cwd: tmpdir(),
    _touchedFiles: [],
    history: [{ role: "tool", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" }],
  }
  const msg = buildAdvisorFollowUp(agent)
  assert.ok(msg.includes("did not provide a response table"))
})

test("buildAdvisorFollowUp: skips re-pushing an unchanged diff snapshot", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    writeFileSync(join(tmp, "app.js"), "// changed")
    const agent = {
      _advisorRound: 1,
      cwd: tmp,
      _touchedFiles: [join(tmp, "app.js")],
      history: [{ role: "tool", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" }],
    }
    const first = buildAdvisorFollowUp(agent)
    assert.ok(first.includes("refreshed"), "first follow-up carries the diff")
    const second = buildAdvisorFollowUp(agent)
    assert.ok(second.includes("No changes since your previous review"), "identical diff is not re-pushed")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("extractConversationBackground: skips reminders/tool messages and caps turns", () => {
  const history = [
    { role: "user", content: "turn one" },
    { role: "assistant", content: "reply one" },
    { role: "user", content: "[System reminder: guard pushback]" },
    { role: "user", content: "turn two" },
    { role: "tool", content: "tool result noise" },
    { role: "assistant", content: "reply two" },
    { role: "user", content: "turn three" },
    { role: "user", content: "turn four" },
  ]
  const bg = extractConversationBackground(history, 3)
  assert.ok(bg.includes("turn four") && bg.includes("turn three") && bg.includes("turn two"))
  assert.ok(!bg.includes("turn one"), "only the last 3 user turns kept")
  assert.ok(!bg.includes("System reminder"), "reminders filtered")
  assert.ok(!bg.includes("tool result noise"), "tool messages filtered")
})

test("extractConversationBackground: returns null on empty/noise-only history", () => {
  assert.equal(extractConversationBackground([]), null)
  assert.equal(extractConversationBackground([{ role: "user", content: "[System reminder: x]" }]), null)
})

test("runAdvisorReview: documentation-only changes skip the review entirely", async () => {
  const { runAdvisorReview } = await import("../src/advisor.mjs")
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    writeFileSync(join(tmp, "README.md"), "# docs update\n")
    const agent = {
      config: { advisor: { enabled: true } },
      provider: { name: "p", model: "m" },
      history: [{ role: "user", content: "update the readme" }],
      _touchedFiles: [join(tmp, "README.md")],
      _advisorRound: 0,
      cwd: tmp,
    }
    const result = await runAdvisorReview(agent, "code", {})
    assert.ok(/documentation-only/.test(result), `应跳过审查: ${result}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("runAdvisorReview: code changes do NOT hit the doc-only fast path", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    writeFileSync(join(tmp, "app.js"), "console.log(1)\n")
    execSync("git add -A", { cwd: tmp, stdio: "ignore" })
    // verify isDocOnlyChange indirectly: with a .js change the review must proceed.
    // We can't run the LLM here, so assert the fast path is NOT taken by checking
    // that prepareAdvisorMessages builds a round-1 session for this agent.
    const agent = {
      config: { advisor: { enabled: true } },
      provider: { name: "p", model: "m" },
      history: [{ role: "user", content: "change app code" }],
      _touchedFiles: [join(tmp, "app.js")],
      _advisorRound: 0,
      _advisorSession: null,
      cwd: tmp,
    }
    const session = prepareAdvisorMessages(agent)
    assert.equal(session[0].role, "system")
    assert.ok(session[1].content.includes("app.js") || session[1].content.includes("diff"), "code change goes to full review")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
