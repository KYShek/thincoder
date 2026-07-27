import { repairHistory, listWorkDir } from "../agent.mjs"
import { execSync, spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * verify tool: pre-completion self-check. When called:
 * 1. git diff --stat — changed file list
 * 2. node --check — syntax check all changed .mjs/.js files
 * 3. npm test — run project tests only when full=true
 * 4. task list + self-review checklist
 * Default does syntax checks only (fast); full=true runs the full test suite.
 * Agent must not say "done" before verify passes. Fix-verify loop at most MAX_VERIFY_RETRIES rounds.
 */
export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. By default runs syntax checks on changed files, shows git diff and task list, and displays a self-review checklist. Set full=true to also run the project's full test suite (npm test). Call this BEFORE declaring any coding task complete — do not say 'done' until verify passes.",
  parameters: {
    type: "object",
    properties: {
      full: { type: "boolean", description: "Also run the full test suite (npm test). Default false — use sparingly, per the testing discipline rules." },
    },
  },
  readonly: true,
  outputPanel: true, // stream test output to a panel instead of inline
  async execute(args, ctx) {
    const cwd = ctx.agent.cwd
    const lines = []
    lines.push("=== VERIFICATION REPORT ===")
    lines.push("")

    // 1. Git diff — find changed files
    let changedFiles = []
    try {
      const diff = execSync("git diff --stat", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      if (diff.trim()) {
        lines.push("Changed files (git diff --stat):")
        lines.push(diff.trim())
        // extract changed file paths
        const nameOnly = execSync("git diff --name-only", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
        changedFiles = nameOnly.trim().split("\n").filter(Boolean)
      } else {
        lines.push("Changed files: (none — no uncommitted changes)")
      }
    } catch {
      lines.push("Changed files: (not a git repo or git unavailable)")
    }

    // 2. Syntax check: run node --check on all changed .mjs/.js files (skip deleted files)
    let syntaxFailed = false
    const jsFiles = changedFiles.filter((f) => /\.(m?js)$/i.test(f))
    if (jsFiles.length > 0) {
      lines.push("")
      lines.push("Syntax check (node --check):")
      for (const f of jsFiles) {
        const abs = join(cwd, f)
        if (!existsSync(abs)) continue // skip deleted files
        try {
          execSync(`node --check "${f}"`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 })
          lines.push(`  ✓ ${f}`)
        } catch (e) {
          syntaxFailed = true
          const errMsg = (e.stderr || e.stdout || e.message || "").toString().split("\n").slice(0, 3).join("\n")
          lines.push(`  ✗ ${f}  — syntax error`)
          lines.push(`    ${errMsg.replace(/\n/g, "\n    ")}`)
        }
      }
      if (!syntaxFailed) lines.push("  All syntax checks passed.")
    }

    // 3. Run project tests (only when full=true)
    if (args.full) {
      try {
        const pkgPath = join(cwd, "package.json")
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
          const testCmd = pkg.scripts?.test
          if (testCmd) {
            lines.push("")
            lines.push(`Tests (${testCmd}):`)
            try {
              const result = await runTestSuite(cwd, ctx)
              const tail = result.stdout.split("\n").slice(-8).join("\n")
              lines.push(tail || "(tests completed)")
              lines.push("")
              lines.push("✓ Tests passed.")
              ctx.agent._verifyPassed = !syntaxFailed // even if tests happen to pass, syntax failure still counts as fail
            } catch (e) {
              const output = e.stdout ? (e.stdout + (e.stderr ? "\n" + e.stderr : "")) : e.message
              const tail = output.split("\n").slice(-15).join("\n")
              lines.push(tail || "(no output)")
              lines.push("")
              lines.push("✗ Tests FAILED. Review the output above, fix the issues, then run verify again.")
              ctx.agent._verifyPassed = false
            }
          } else {
            lines.push("")
            lines.push("Tests: no test script in package.json — skipped.")
            ctx.agent._verifyPassed = !syntaxFailed
          }
        }
      } catch {
        lines.push("Tests: (unable to run — no package.json or npm unavailable)")
      }
    } else {
      // Quick mode: skip tests but hint that full verification is available
      const pkgPath = join(cwd, "package.json")
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
          if (pkg.scripts?.test) {
            lines.push("")
            lines.push("Tests: skipped (default quick mode). Run verify with full=true or npm test to run the full suite.")
          }
        } catch { /* ignore */ }
      }
      ctx.agent._verifyPassed = !syntaxFailed // quick mode: syntax failure must not count as pass
    }

    // 4. Task list
    lines.push("")
    if (ctx.agent.tasks.length === 0) {
      lines.push("Task list: (no tasks tracked)")
    } else {
      const done = ctx.agent.tasks.filter((t) => t.status === "done").length
      const total = ctx.agent.tasks.length
      const open = ctx.agent.tasks.filter((t) => t.status !== "done")
      lines.push(`Task list: ${done}/${total} done`)
      for (const t of ctx.agent.tasks) {
        const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○"
        lines.push(`  ${mark} [${t.status}] ${t.title}`)
      }
      if (open.length > 0) {
        lines.push("")
        lines.push(`WARNING: ${open.length} task(s) still open. Complete them or explain why they can be left undone.`)
      }
    }

    // 5. Checklist
    lines.push("")
    lines.push("Self-review checklist:")
    lines.push("- [ ] Did I run the project's tests and do they pass?")
    lines.push("- [ ] Did I read every file I changed to catch leftover debug code or stale comments?")
    lines.push("- [ ] Do comments and docstrings match what the code actually does?")
    lines.push("- [ ] Did I remove placeholder code, TODO stubs, or commented-out experiment blocks?")
    lines.push("- [ ] If I used a subagent, did I verify its report against the actual files it touched?")
    lines.push("- [ ] Are all task items genuinely done (not just marked done to finish early)?")

    return lines.join("\n")
  },
}

/**
 * Run npm test via spawn, no maxBuffer limit.
 * Test output is streamed through ctx.callbacks.onToolOutput (TUI can display progress in real time).
 * On success returns { stdout, stderr }; on non-zero exit throws (with stdout/stderr for caller to extract tail).
 */
function runTestSuite(cwd, ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["test"], {
      cwd, shell: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      const s = d.toString()
      stdout += s
      ctx.callbacks?.onToolOutput?.("verify", s)
    })
    child.stderr.on("data", (d) => {
      const s = d.toString()
      stderr += s
      ctx.callbacks?.onToolOutput?.("verify", s)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      const err = new Error("Tests timed out after 120s")
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    }, 120000)
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const err = new Error(`Tests exited with code ${code}`)
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      }
    })
  })
}

