import { repairHistory, listWorkDir } from "../agent.mjs"
import { execSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * verify 工具：完成前的自检。调用时会：
 * 1. git diff --stat — 变更文件列表
 * 2. node --check — 语法检查所有变更的 .mjs/.js 文件
 * 3. npm test — 仅在 full=true 时运行项目测试
 * 4. task 列表 + 自检清单
 * 默认只做语法检查（快），full=true 时才跑全量测试。Agent 不应该在 verify 通过前说"完成"。修复-验证循环最多 MAX_VERIFY_RETRIES 轮。
 */
export const verifyTool = {
  name: "verify",
  description:
    "Run a pre-completion self-check. By default runs syntax checks on changed files, shows git diff and task list, and displays a self-review checklist. Set full=true to also run the project's full test suite (npm test). Call this BEFORE declaring any coding task complete — do not say 'done' until verify passes.",
  parameters: {
    type: "object",
    properties: {
      full: { type: "boolean", description: "Also run the full test suite (npm test). Default false — only run when completing a task or the user asks." },
    },
  },
  readonly: true,
  async execute(args, ctx) {
    const cwd = ctx.agent.cwd
    const lines = []
    lines.push("=== VERIFICATION REPORT ===")
    lines.push("")

    // 1. Git diff — 找出变更文件
    let changedFiles = []
    try {
      const diff = execSync("git diff --stat", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      if (diff.trim()) {
        lines.push("Changed files (git diff --stat):")
        lines.push(diff.trim())
        // 提取变更文件路径
        const nameOnly = execSync("git diff --name-only", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
        changedFiles = nameOnly.trim().split("\n").filter(Boolean)
      } else {
        lines.push("Changed files: (none — no uncommitted changes)")
      }
    } catch {
      lines.push("Changed files: (not a git repo or git unavailable)")
    }

    // 2. 语法检查：对所有变更的 .mjs/.js 跑 node --check（跳过已删除的文件）
    let syntaxFailed = false
    const jsFiles = changedFiles.filter((f) => /\.(m?js)$/i.test(f))
    if (jsFiles.length > 0) {
      lines.push("")
      lines.push("Syntax check (node --check):")
      for (const f of jsFiles) {
        const abs = join(cwd, f)
        if (!existsSync(abs)) continue // 已删除的文件跳过
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

    // 3. 运行项目测试（仅 full=true 时）
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
              const result = execSync(`npm test`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
              const tail = result.split("\n").slice(-8).join("\n")
              lines.push(tail || "(tests completed)")
              lines.push("")
              lines.push("✓ Tests passed.")
              ctx.agent._verifyPassed = !syntaxFailed // 语法挂了即使测试侥幸过也不算通过
            } catch (e) {
              const output = ((e.stdout || "") + (e.stderr || "")).toString()
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
      // 快速模式：跳过测试，但提示可以跑完整校验
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
      ctx.agent._verifyPassed = !syntaxFailed // quick 模式：语法失败不能算通过
    }

    // 4. Task 列表
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
