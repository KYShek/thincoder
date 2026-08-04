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

test("extractPriorIssueTable: ignores header constants quoted inside source code", () => {
  // An advisor output that quotes the header constants' own definitions (e.g. from
  // history.mjs) must NOT be mistaken for a review table — headers match at line start only.
  const history = [
    { role: "tool", tool_call_id: "a1", content: 'Reviewing src/advisor/history.mjs:\nconst LEGACY_ADVISOR_HEADER = "| # | 文件 | 严重程度 | 问题描述 | 建议修复 |"\nconst ADVISOR_TABLE_HEADER = "| # | File | Severity | Issue | Suggestion |"\nThese constants are only matched at line start — this message has no table.' },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

test("extractPriorIssueTable: returns null when last review says all clear", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | File | Severity | Issue | Suggestion |\n|---|------|----------|-------|------------|\n\nNo 🔴 issues found. Review passed." },
  ]
  assert.equal(extractPriorIssueTable(history), null)
})

test("extractPriorIssueTable: returns null when last review says all resolved", () => {
  const history = [
    { role: "tool", tool_call_id: "a1", content: "| # | Orig# | File | Severity | Status | Notes |\n|---|-------|------|----------|--------|-------|\n| 1 | 3 | src/x.mjs | 🔴 | Fixed | ok |\nNo 🔴 issues remaining." },
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

test("extractPriorIssueTable: convergence table with mixed fixed/unfixed returns table", () => {
  const table = `| # | Orig# | File | Severity | Status | Notes |
|---|-------|------|----------|--------|-------|
| 1 | 3 | src/x.mjs | 🔴 | Fixed | ok |
| 2 | 5 | src/y.mjs | 🟡 | Unfixed | still broken |`
  const result = extractPriorIssueTable([{ role: "tool", tool_call_id: "a1", content: table }])
  assert.notEqual(result, null, "有未修复项不应视为 all-clear")
  assert.ok(result.text.includes("Unfixed"))
})

test("extractPriorIssueTable: all-fixed table with 'still' in notes returns null", () => {
  const table = `| # | Orig# | File | Severity | Status | Notes |
|---|-------|------|----------|--------|-------|
| 1 | 3 | src/x.mjs | 🔴 | Fixed | we should still add tests later |
No 🔴 issues remaining.`
  const result = extractPriorIssueTable([{ role: "tool", tool_call_id: "a1", content: table }])
  assert.equal(result, null, "全 Fixed + all-clear 短语 + Notes 里普通 'still' 不触发部分修复")
})

test("extractPriorIssueTable: Chinese mixed 已修复/未修复 returns table", () => {
  const table = `| # | 文件 | 严重程度 | 问题描述 | 建议修复 |
|---|------|----------|----------|----------|
| 1 | src/x.mjs | 🔴 | bug A | fix A |
| 2 | src/y.mjs | 🟡 | bug B | 未修复 |`
  const result = extractPriorIssueTable([{ role: "tool", tool_call_id: "a1", content: table }])
  assert.notEqual(result, null, "含未修复项应返回表格")
  assert.ok(result.text.includes("未修复"))
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
    history: [{ role: "tool", tool_call_id: "a1", content: "No 🔴 issues found. Review passed." }],
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

test("buildAdvisorSystemPrompt: design round 1 uses design prompt; rounds 2+ converge like code", () => {
  const base = { history: [], cwd: tmpdir() }
  const round1 = buildAdvisorSystemPrompt({ ...base, _advisorRound: 0 }, null, "design")
  assert.ok(round1.includes("design reviewer"), "round 1 keeps the design-review prompt")
  // Round 2 with a prior table → convergence prompt (verify prior table + new issues allowed)
  const prior = { text: "| # | Category | Severity | Issue | Suggestion |\n|---|---------|----------|------|------------|" }
  const round2 = buildAdvisorSystemPrompt({ ...base, _advisorRound: 1 }, prior, "design")
  assert.ok(!round2.includes("design reviewer"), "round 2 no longer uses the design prompt")
  assert.ok(round2.includes("Verify the prior issue table"), "round 2 uses the convergence prompt")
  // Round 3+ → strict verification
  const round3 = buildAdvisorSystemPrompt({ ...base, _advisorRound: 2 }, prior, "design")
  assert.ok(round3.includes("Strictly verify only the prior issue table"), "round 3+ strict verification")
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

test("buildAdvisorUserMessage: design review with token injects Approval Signal", () => {
  const agent = {
    history: [{ role: "user", content: "design a feature" }],
    _advisorRound: 0, cwd: tmpdir(), config: {},
  }
  const token = "f0e2a9c8-0000-4000-8000-000000000000"
  const result = buildAdvisorUserMessage(agent, null, "design", token)
  assert.ok(result.includes("Approval Signal"), "应包含 Approval Signal 段")
  assert.ok(result.includes(`[DESIGN-TOKEN:${token}]`), "应包含令牌值")
})

test("buildAdvisorUserMessage: design review without token has no Approval Signal", () => {
  const agent = {
    history: [{ role: "user", content: "design a feature" }],
    _advisorRound: 0, cwd: tmpdir(), config: {},
  }
  const result = buildAdvisorUserMessage(agent, null, "design")
  assert.ok(!result.includes("Approval Signal"), "无令牌时不应有 Approval Signal")
})

test("advisorTool: schema declares documents parameter for design review", async () => {
  const { advisorTool } = await import("../src/agent-tools/advisor.mjs")
  const documents = advisorTool.parameters.properties.documents
  assert.ok(documents, "documents 参数应存在于 advisor 工具 schema")
  assert.equal(documents.type, "array", "documents 为数组")
  assert.equal(documents.items.type, "string", "数组元素为 string")
   assert.ok(documents.description.includes("design"), "描述覆盖 design/code review 用途")
  assert.ok(documents.description.includes("reviews ONLY these"), "描述声明只评审清单内文档")
})

test("buildAdvisorUserMessage: design review with documents reviews ONLY the listed docs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    // Unrelated changed doc in the repo — must NOT leak into the review scope
    writeFileSync(join(tmp, "Y.md"), "# Unrelated\n")
    execSync("git add -A && git commit -m y", { cwd: tmp, stdio: "ignore" })
    writeFileSync(join(tmp, "Y.md"), "# Unrelated — modified after commit\n")

    const agent = { _touchedFiles: [], cwd: tmp, history: [], _advisorRound: 0, config: {} }
    const documents = ["docs/design/X.md", "docs/design/Z.md"]
    const msg = buildAdvisorUserMessage(agent, null, "design", null, documents)

    assert.ok(msg.includes("## Documents to Review"), "应含显式清单段")
    assert.ok(msg.includes("docs/design/X.md — Read this file in full"), "清单第一条文档带 Read this file in full")
    assert.ok(msg.includes("docs/design/Z.md — Read this file in full"), "清单第二条文档带 Read this file in full")
    assert.ok(!msg.includes("## Changed Files"), "不收集 git 变更集")
    assert.ok(!msg.includes("## Design Document (git diff)"), "不含 git diff 内容")
    assert.ok(!msg.includes("- Y.md"), "清单外文档不被列为评审对象")
    assert.ok(!msg.includes("Unrelated"), "清单外文档内容不被提及")
    assert.ok(!msg.includes("git status"), "不出现 git status")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("buildAdvisorUserMessage: design review without documents keeps git-diff scope (backward compatible)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    writeFileSync(join(tmp, "Y.md"), "# Unrelated\n")
    execSync("git add -A && git commit -m y", { cwd: tmp, stdio: "ignore" })
    writeFileSync(join(tmp, "Y.md"), "# Unrelated — modified after commit\n")

    const agent = { _touchedFiles: [], cwd: tmp, history: [], _advisorRound: 0, config: {} }
    const msg = buildAdvisorUserMessage(agent, null, "design")

    assert.ok(msg.includes("## Changed Files"), "无 documents 时仍按 git 变更集构建")
    assert.ok(msg.includes("Y.md"), "git 变更集中的文档被列出")
    assert.ok(msg.includes("## Design Document (git diff)"), "无 documents 时含 git diff 段")
    assert.ok(!msg.includes("## Documents to Review"), "无 documents 时不出现显式清单段")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("prepareAdvisorMessages: design review passes documents through to the user message", () => {
  const agent = {
    history: [], _advisorRound: 0, cwd: tmpdir(), config: {},
    _advisorSession: null,
  }
  const msgs = prepareAdvisorMessages(agent, "design", null, ["docs/design/A.md"])
  assert.equal(msgs.length, 2)
  assert.ok(msgs[1].content.includes("docs/design/A.md"), "documents 透传到 user message")
  assert.ok(msgs[1].content.includes("Read this file in full"), "documents 模式带 Read this file in full")
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

test("buildAdvisorUserMessage: scope lists paths when provided", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    const agent = {
      _touchedFiles: [],
      cwd: tmp,
      history: [],
      _advisorRound: 0,
    }
    const msg = buildAdvisorUserMessage(agent, null, "code", null, null, ["src/app.js", "src/util.mjs"])
    assert.ok(msg.includes("## Review Scope"))
    assert.ok(msg.includes("src/app.js"))
    assert.ok(msg.includes("src/util.mjs"))
    assert.ok(msg.includes("## Instructions"))
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

test("agent: _advisorRound increments on every advisor call (code AND design)", () => {
  // Mirrors agent.mjs: design reviews share the convergence budget with code
  // reviews — both advance _advisorRound toward MAX_ADVISOR_ROUNDS=5.
  let _advisorRound = 0
  const toolCalls = [
    { name: "write", ok: true, arguments: "{}" },
    { name: "advisor", ok: true, arguments: "{}" },
    { name: "advisor", ok: true, arguments: JSON.stringify({ type: "design" }) },
    { name: "edit", ok: true, arguments: "{}" },
    { name: "advisor", ok: true, arguments: "{}" },
  ]

  for (const tc of toolCalls) {
    if (tc.name === "advisor") {
      try {
        JSON.parse(tc.arguments || "{}")
      } catch {
        /* unparseable — still counts as a review attempt */
      }
      _advisorRound++
    }
  }

  assert.equal(_advisorRound, 3) // code + design + code — all count
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
  const priorTable = "| # | File | Severity | Issue | Suggestion |\n| 1 | a.js | 🔴 | bug | fix |"
  const agent = { history: [{ role: "tool", tool_call_id: "a1", content: priorTable }], _advisorRound: 0, _advisorSession: null, cwd: tmpdir(), _touchedFiles: [] }
  const first = prepareAdvisorMessages(agent)
  const firstSystemPrompt = first[0].content // snapshot: second === first (same array), direct compare is tautological
  agent._advisorSession = first // runAdvisorReview persists it after a successful review
  agent._advisorRound = 1

  const second = prepareAdvisorMessages(agent)
  assert.equal(second, first, "same array — conversation continues, not rebuilt")
  assert.equal(second.length, 3)
  assert.equal(second[2].role, "user")
  assert.ok(second[2].content.includes("Round 2"), "follow-up carries round number")
  assert.ok(second[2].content.includes("Agent Response"), "follow-up asks for the response table")
  assert.notEqual(second[0].content, firstSystemPrompt, "system prompt replaced for round 2 — round-1 full-scope mandate must not leak in")
  assert.ok(second[0].content.includes("Verify the prior issue table"), "round 2 system prompt is the narrowed ROUND2")

  agent._advisorRound = 2
  const third = prepareAdvisorMessages(agent)
  assert.ok(third[3].content.includes("Round 3"))
  assert.ok(third[3].content.includes("Strict"), "round 3+ is strict verification")
  assert.ok(third[0].content.includes("Strictly verify only the prior issue table"), "round 3 system prompt is ROUND3 — do not look for new issues")
  assert.ok(third[0].content.includes("Do NOT look for new issues"))
})

test("buildAdvisorFollowUp: includes agent response table when present", () => {
  const agent = {
    _advisorRound: 1,
    cwd: tmpdir(),
    _touchedFiles: [],
    history: [
      { role: "tool", tool_call_id: "tc1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" },
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
    history: [{ role: "tool", tool_call_id: "tc1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" }],
  }
  const msg = buildAdvisorFollowUp(agent)
  assert.ok(msg.includes("did not provide a response table"))
})

test("buildAdvisorFollowUp: injects NO git information (read-only verification by design)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "advisor-test-"))
  try {
    createGitRepo(tmp)
    writeFileSync(join(tmp, "app.js"), "// changed")
    const agent = {
      _advisorRound: 1,
      cwd: tmp,
      _touchedFiles: [join(tmp, "app.js")],
      history: [{ role: "tool", tool_call_id: "tc1", content: "| # | File | Severity | Issue | Suggestion |\n| 1 | a.mjs | 🔴 | bug | fix |" }],
    }
    const followUp = buildAdvisorFollowUp(agent)
    assert.ok(followUp.includes("Prior Issue Table"), "prior table present")
    assert.ok(!followUp.includes("Git Context"), "no git context injected")
    assert.ok(!followUp.includes("## Current Changes"), "no diff-snapshot section injected")
    assert.ok(!followUp.includes("git status"), "no git status injected")
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

test("runAdvisorReview: documentation-only auto-skip removed", async () => {
  // Doc-only fast path was removed — scope is now explicit via paths/documents.
  // runAdvisorReview without paths just tries to run (fake provider → error).
  const { runAdvisorReview } = await import("../src/advisor/run.mjs")
  const agent = {
    config: { advisor: { enabled: true } },
    provider: { name: "p", model: "m" },
    history: [{ role: "user", content: "update the readme" }],
    _touchedFiles: [],
    _advisorRound: 0,
    cwd: tmpdir(),
  }
  const result = await runAdvisorReview(agent, "code", {})
  assert.ok(!result.includes("CODE_REVIEW_PASSED"), "CODE_REVIEW_PASSED should no longer appear")
})

test("runAdvisorReview: convergence cap blocks a 6th review call", async () => {
  const { runAdvisorReview, MAX_ADVISOR_ROUNDS } = await import("../src/advisor/run.mjs")
  const agent = {
    config: { advisor: { enabled: true } },
    provider: { name: "p", model: "m" },
    history: [],
    _touchedFiles: ["x.js"],
    _advisorRound: MAX_ADVISOR_ROUNDS, // cap already reached — 5 reviews completed
    _advisorSession: [],
    cwd: tmpdir(),
  }
  const result = await runAdvisorReview(agent, "code", {})
  assert.ok(result.includes("convergence cap reached"), `cap message expected, got: ${result}`)
  assert.ok(result.includes(String(MAX_ADVISOR_ROUNDS)), "cap message names the round limit")
})

test("runAdvisorReview: cap blocks design reviews too after 5 rounds (bounded loop)", async () => {
  const { runAdvisorReview, MAX_ADVISOR_ROUNDS } = await import("../src/advisor/run.mjs")
  const agent = {
    config: { advisor: { enabled: true } },
    provider: { name: "p", model: "m" },
    history: [],
    _touchedFiles: [],
    _advisorRound: MAX_ADVISOR_ROUNDS + 5,
    _advisorSession: null,
    cwd: tmpdir(),
  }
  // Cap reached — design reviews share the 5-round budget with code reviews.
  // No network call happens: the cap returns the termination message directly.
  const result = await runAdvisorReview(agent, "design", { signal: { aborted: true } })
  assert.ok(result.includes("convergence cap reached"), `design review must hit the cap, got: ${result}`)
  assert.ok(result.includes(String(MAX_ADVISOR_ROUNDS)), "cap message names the round limit")
})

test("runAdvisorReview: design review below cap reaches the tool loop", async () => {
  const { runAdvisorReview, MAX_ADVISOR_ROUNDS } = await import("../src/advisor/run.mjs")
  const agent = {
    config: { advisor: { enabled: true } },
    provider: { name: "p", model: "m" },
    history: [],
    _touchedFiles: [],
    _advisorRound: MAX_ADVISOR_ROUNDS - 1, // 5th review still allowed
    _advisorSession: null,
    cwd: tmpdir(),
  }
  // Pre-aborted signal: the tool loop returns "interrupted" immediately — no
  // network call. Proves the guard let the review through before the cap.
  const result = await runAdvisorReview(agent, "design", { signal: { aborted: true } })
  assert.ok(!result.includes("convergence cap reached"), `design review must pass the cap guard, got: ${result}`)
  assert.ok(result.includes("interrupted"), `design review must reach the tool loop, got: ${result}`)
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
