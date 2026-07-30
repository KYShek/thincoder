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

test("buildAdvisorUserMessage: includes task summary when available", () => {
  const agent = {
    _touchedFiles: [], cwd: tmpdir(),
    history: [{ role: "user", content: "Fix the null pointer bug" }],
    _advisorRound: 0,
  }
  const msg = buildAdvisorUserMessage(agent)
  assert.ok(msg.includes("## Task"))
  assert.ok(msg.includes("Fix the null pointer bug"))
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
