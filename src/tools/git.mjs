import {
  DESC,
  truncate,
  runGit
} from "./shared.mjs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const gitDiffTool = {
  name: "git_diff",
  description: DESC("git_diff"),
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes (default false)" },
      path: { type: "string", description: "File or directory to diff (default all)" },
      ref: { type: "string", description: "Compare against this ref (default HEAD)" },
    },
  },
  readonly: true,
  execute(args, ctx) {
    const ref = args.ref ?? "HEAD"
    // ref 由模型提供且位于 "--" 之前：校验字符集，防 "--output=..." 之类被 git 当成选项
    if (!/^[A-Za-z0-9._\/~^][A-Za-z0-9._\/~^-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
    const flags = args.staged ? ["--staged"] : []
    const paths = args.path ? [args.path] : []
    const out = runGit(ctx.cwd, ["diff", ...flags, ref, "--", ...paths])
    return truncate(out || "(no changes)")
  },
}

// ---------------------------------------------------------------- git_status

export const gitStatusTool = {
  name: "git_status",
  description: DESC("git_status"),
  parameters: {
    type: "object",
    properties: {},
  },
  readonly: true,
  execute(_args, ctx) {
    const porcelain = runGit(ctx.cwd, ["status", "--porcelain"])
    if (!porcelain) return "(clean — no changes)"

    const staged = []
    const unstaged = []
    const untracked = []
    const conflicts = []
    for (const line of porcelain.split("\n")) {
      if (!line) continue
      // porcelain: XY path — 2 状态字符 + 空格 + 文件路径（部分环境只 1 空格）
      // 去掉可能的 CR（execFileSync 在某些 Windows git 下会残留 \r 在行末但不在换行符中）
      const clean = line.replace(/\r/g, "")
      // 尝试匹配 "XY path" 或 "XY  path"（可变间距）
      const m = clean.match(/^(..?)\s+(.+)$/)
      if (!m) continue
      const [, status, rawFile] = m
      // 重命名条目 porcelain 输出为 "R  old -> new"，拆开明确展示而非当成一个字面文件名
      const file = status.includes("R") && rawFile.includes(" -> ") ? rawFile.replace(" -> ", " → ") : rawFile
      const idx = status[0] ?? " "
      const wt = status[1] ?? " "
      if (idx === "U" || wt === "U" || (idx === "A" && wt === "A")) {
        conflicts.push(file)
      } else if (idx === "?" && wt === "?") {
        untracked.push(file)
      } else {
        if (idx !== " " && idx !== "?") staged.push(idx + " " + file)
        if (wt !== " " && wt !== "?") unstaged.push(wt + " " + file)
      }
    }
    const parts = []
    if (staged.length) parts.push("Staged (" + staged.length + "):\n" + staged.join("\n"))
    if (unstaged.length) parts.push("Unstaged (" + unstaged.length + "):\n" + unstaged.join("\n"))
    if (untracked.length) parts.push("Untracked (" + untracked.length + "):\n" + untracked.join("\n"))
    if (conflicts.length) parts.push("Conflicts (" + conflicts.length + "):\n" + conflicts.join("\n"))
    return truncate(parts.join("\n\n"))
  },
}

// ---------------------------------------------------------------- git_log

export const gitLogTool = {
  name: "git_log",
  description: DESC("git_log"),
  parameters: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 10)" },
      path: { type: "string", description: "File or directory (default all)" },
      oneline: { type: "boolean", description: "One-line-per-commit format (default false)" },
    },
  },
  readonly: true,
  execute(args, ctx) {
    const n = args.count ?? 10
    const isOneline = args.oneline
    const cmdArgs = isOneline
      ? ["log", "-" + n, "--oneline"]
      : ["log", "-" + n, "--format=%h %ad %an %s", "--date=short"]
    if (args.path) cmdArgs.push("--", args.path)
    const out = runGit(ctx.cwd, cmdArgs)
    return truncate(out || "(no commits)")
  },
}

// ---------------------------------------------------------------- question

export const questionTool = {
  name: "question",
  description: DESC("question"),
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Single-choice options for the user to pick from (optional)",
      },
    },
    required: ["question"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (!ctx.onQuestion) throw new Error("question tool not supported in this context (no UI to ask)")
    return ctx.onQuestion(args.question, args.options ?? [])
  },
}

/** 执行 git 命令；非 git 仓库 / git 不可用时返回空字符串 */

// ---------------------------------------------------------------- checkpoint

export const checkpointTool = {
  name: "checkpoint",
  description: DESC("checkpoint"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create", "rewind"], description: "list snapshots / create one now / restore a snapshot by id" },
      id: { type: "string", description: "Snapshot id (required for rewind)" },
    },
    required: ["action"],
  },
  readonly: false,
  async execute(args, ctx) {
    const { createCheckpoint, listCheckpoints, rewind, isGitRepo } = await import("../git/checkpoint.mjs")
    if (!isGitRepo(ctx.cwd)) throw new Error("Not a git repository — checkpoints unavailable")
    if (args.action === "create") {
      const cp = await createCheckpoint(ctx.cwd)
      return `Checkpoint ${cp.id} created (${cp.files} file(s) captured)`
    }
    if (args.action === "rewind") {
      if (!args.id) throw new Error("id is required for rewind — use action=list to see snapshot ids")
      const s = await rewind(ctx.cwd, args.id)
      return `Rewound to checkpoint ${args.id}: patch ${s.patchApplied ? "applied" : "(empty)"}, ${s.restored} untracked file(s) restored, ${s.deleted} file(s) deleted.\n(The pre-rewind state was snapshotted first — you can rewind again to go back.)`
    }
    if (args.action === "list") {
      const cps = await listCheckpoints(ctx.cwd)
      if (cps.length === 0) return "(no checkpoints yet — one is auto-created before each user task)"
      return cps.map((c) => `${c.id}  ${new Date(c.time).toISOString()}  ${c.untracked} untracked file(s)`).join("\n")
    }
    throw new Error(`Unknown action: ${args.action}`)
  },
}
