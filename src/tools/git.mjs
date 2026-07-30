import {
  DESC,
  truncate,
  runGit
} from "./shared.mjs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const gitTool = {
  name: "git",
  description:
    "Run a git command. Use this to see uncommitted changes, staged changes, diff against a ref, recent commits, or manage checkpoints. Only works inside a git repository.\n" +
    "- action='diff': Show unified diff — what changed since last commit. Set staged=true for staged-only diff, ref=<ref> to compare against a specific commit/branch, path=<dir> to scope to a file or directory.\n" +
    "- action='status': Show working tree state — staged, unstaged, untracked files, and conflicts. Returns categorized lists.\n" +
    "- action='log': Show recent commit history. Set count to limit, oneline=true for compact format, path=<file> to see history of one file.\n" +
    "- action='checkpoint': Manage git-based snapshots. Use checkpointAction to choose: list (overview), create (snapshot now), rewind (restore snapshot by id), cat (read a file from a snapshot).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diff", "status", "log", "checkpoint"], description: "diff / status / log / checkpoint" },
      // diff/log params
      staged: { type: "boolean", description: "(diff) Show staged changes instead of working tree" },
      path: { type: "string", description: "(diff/log/checkpoint:cat/checkpoint:rewind) File or directory to scope to" },
      ref: { type: "string", description: "(diff) Compare against this ref (default HEAD)" },
      count: { type: "number", description: "(log) Number of commits (default 10)" },
      oneline: { type: "boolean", description: "(log) One-line-per-commit format" },
      // checkpoint params
      checkpointAction: { type: "string", enum: ["list", "create", "rewind", "cat"], description: "(checkpoint) list snapshots / create one / restore by id / read file from snapshot" },
      checkpointId: { type: "string", description: "(checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)" },
    },
    required: ["action"],
  },
  readonly: false,
  async execute(args, ctx) {
    switch (args.action) {
      case "diff": {
        const ref = args.ref ?? "HEAD"
        if (!/^[A-Za-z0-9._\/~^][A-Za-z0-9._\/~^-]*$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`)
        const flags = args.staged ? ["--staged"] : []
        const paths = args.path ? [args.path] : []
        const out = runGit(ctx.cwd, ["diff", ...flags, ref, "--", ...paths])
        return truncate(out || "(no changes)")
      }
      case "status": {
        const porcelain = runGit(ctx.cwd, ["status", "--porcelain"])
        if (!porcelain) return "(clean — no changes)"

        const staged = []
        const unstaged = []
        const untracked = []
        const conflicts = []
        for (const line of porcelain.split("\n")) {
          if (!line) continue
          const clean = line.replace(/\r/g, "")
          const m = clean.match(/^(..?)\s+(.+)$/)
          if (!m) continue
          const [, status, rawFile] = m
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
      }
      case "log": {
        const n = Math.min(Math.max(1, args.count ?? 10), 200)
        const isOneline = args.oneline
        const cmdArgs = isOneline
          ? ["log", "-" + n, "--oneline"]
          : ["log", "-" + n, "--format=%h %ad %an %s", "--date=short"]
        if (args.path) cmdArgs.push("--", args.path)
        const out = runGit(ctx.cwd, cmdArgs)
        return truncate(out || "(no commits)")
      }
      case "checkpoint": {
        const { createCheckpoint, listCheckpoints, rewind, isGitRepo } = await import("../git/checkpoint.mjs")
        if (!isGitRepo(ctx.cwd)) throw new Error("Not a git repository — checkpoints unavailable")

        const sub = args.checkpointAction
        if (!sub) return "checkpoint: missing checkpointAction — use: list | create | rewind | cat"

        if (sub === "create") {
          const cp = await createCheckpoint(ctx.cwd)
          return `Checkpoint ${cp.id} created (${cp.files} file(s): ${cp.tracked.length} tracked, ${cp.untracked.length} untracked)`
        }
        if (sub === "rewind") {
          if (!args.checkpointId) throw new Error("checkpointId is required for rewind — use checkpointAction=list to see snapshot ids")
          const s = await rewind(ctx.cwd, args.checkpointId, { path: args.path })
          if (args.path) {
            return `Restored "${args.path}" (${s.type}) from checkpoint ${args.checkpointId}.\n(The pre-rewind state was snapshotted first — you can rewind again to go back.)`
          }
          return `Rewound to checkpoint ${args.checkpointId}: patch ${s.patchApplied ? "applied" : "(empty)"}, ${s.restored ?? 0} untracked file(s) restored, ${s.deleted ?? 0} file(s) deleted.\n(The pre-rewind state was snapshotted first — you can rewind again to go back.)`
        }
        if (sub === "cat") {
          if (!args.checkpointId) throw new Error("checkpointId is required for cat — use checkpointAction=list to see snapshot ids")
          if (!args.path) throw new Error("path is required for cat — specify which file to read")
          const { catFile } = await import("../git/checkpoint.mjs")
          return await catFile(ctx.cwd, args.checkpointId, args.path)
        }
        if (sub === "list") {
          const cps = await listCheckpoints(ctx.cwd)
          if (cps.length === 0) return "(no checkpoints yet — one is auto-created before each user task)"

          // Specific id: show the file tree within that snapshot
          if (args.checkpointId) {
            const cp = cps.find((c) => c.id === args.checkpointId)
            if (!cp) throw new Error(`checkpoint ${args.checkpointId} not found`)
            return formatFileTree(cp)
          }

          // Overview: list of all snapshots
          return cps.map((c) => {
            const parts = [`${c.id}  ${new Date(c.time).toISOString()}`]
            if (c.tracked.length) parts.push(`${c.tracked.length} tracked: ${c.tracked.join(", ")}`)
            if (c.untracked.length) parts.push(`${c.untracked.length} untracked: ${c.untracked.join(", ")}`)
            return parts.join("  ")
          }).join("\n")
        }
        throw new Error(`Unknown checkpoint action: ${sub}. Use: list | create | rewind | cat`)
      }
      default:
        return `Unknown action '${args.action}'. Use: diff | status | log | checkpoint`
    }
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

/** Format a checkpoint's file list as a directory tree (directories first, indented display) */
function formatFileTree(cp) {
  const all = [
    ...(cp.tracked ?? []).map((f) => ({ path: f, type: "" })),
    ...(cp.untracked ?? []).map((f) => ({ path: f, type: " (untracked)" })),
  ]
  if (all.length === 0) return "(empty checkpoint)"

  all.sort((a, b) => a.path.localeCompare(b.path))

  const tree = new Map()
  for (const { path, type } of all) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
    if (!tree.has(dir)) tree.set(dir, [])
    tree.get(dir).push({ name: path.slice(dir === "." ? 0 : dir.length + 1), type })
  }

  const lines = []
  const dirs = [...tree.keys()].sort()
  for (const dir of dirs) {
    if (dir !== "." && !lines.includes(dir + "/")) {
      const parts = dir.split("/")
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/") + "/"
        if (!lines.includes(prefix)) lines.push(prefix)
      }
    }
  }
  for (const dir of dirs) {
    if (dir !== ".") {
      for (const { name, type } of tree.get(dir)) {
        lines.push(`  ${dir}/${name}${type}`)
      }
    }
  }
  for (const { name, type } of tree.get(".") ?? []) {
    lines.push(name + type)
  }

  return lines.join("\n")
}
