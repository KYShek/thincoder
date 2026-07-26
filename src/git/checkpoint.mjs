/**
 * checkpoint.mjs — 工作区快照与回滚
 * 快照 = git diff HEAD 补丁 + 未跟踪文件副本（尊重 .gitignore）。
 * 仅 git 仓库内可用。回滚前会先打新快照（回滚可逆）。
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { configDir } from "../config.mjs"

const MAX_CHECKPOINTS = 20

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch (error) {
    if (allowFail) return null
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr?.toString().trim() || error.message}`)
  }
}

function checkpointRoot(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(configDir, "checkpoints", hash)
}

/** 当前目录是否 git 仓库 */
export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }) === "true"
}

/**
 * 打快照。返回 { id, time, files } 或 null（非 git 仓库）。
 */
export async function createCheckpoint(cwd) {
  if (!isGitRepo(cwd)) return null

  // 随机后缀：同一毫秒内两次快照的 id 不互撞（排序仍按时间戳前缀有序）
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  const dir = join(checkpointRoot(cwd), id)
  await mkdir(join(dir, "untracked"), { recursive: true })

  // 跟踪文件的改动 → 补丁
  const patch = git(cwd, ["diff", "HEAD", "--binary"], { allowFail: true }) ?? ""
  await writeFile(join(dir, "patch.diff"), patch, "utf8")

  // 未跟踪文件（尊重 .gitignore）→ 原样复制
  const untrackedRaw = git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? ""
  const untracked = untrackedRaw ? untrackedRaw.split("\n").filter(Boolean) : []
  for (const rel of untracked) {
    const src = join(cwd, rel)
    const dst = join(dir, "untracked", rel)
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(src, dst).catch(() => {}) // 复制失败（socket/设备文件等）跳过
  }
  await writeFile(join(dir, "meta.json"), JSON.stringify({ id, time: Date.now(), untracked }, null, 2), "utf8")

  await pruneCheckpoints(cwd)
  return { id, time: Date.now(), files: untracked.length + (patch ? 1 : 0) }
}

/** 列出快照（新→旧） */
export async function listCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  if (!existsSync(root)) return []
  const ids = (await readdir(root)).sort().reverse()
  const out = []
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"))
      out.push({ id, time: meta.time, untracked: meta.untracked.length })
    } catch {
      // 损坏的快照跳过
    }
  }
  return out
}

/**
 * 回滚到指定快照（先把当前状态存成新快照，保证回滚可逆）。
 * 返回恢复摘要。
 */
export async function rewind(cwd, id) {
  const dir = join(checkpointRoot(cwd), id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))

  // 回滚也可逆：先给当前状态打快照
  await createCheckpoint(cwd)

  // 1. 工作区+暂存区 → HEAD，再应用快照补丁 → 快照时状态
  // 必须连暂存区一起重置：checkout -- . 只从 index 恢复工作区，
  // 有 staged 改动时工作区留下的是 staged 版本，补丁（diff HEAD，含 staged 内容）会 apply 失败
  git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "."])
  const patch = await readFile(join(dir, "patch.diff"), "utf8")
  if (patch.trim()) {
    const patchFile = join(dir, "patch.diff")
    git(cwd, ["apply", "--whitespace=nowarn", patchFile])
  }

  // 2. 快照之后新建的未跟踪文件 → 删除
  const nowUntracked = (git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? "")
    .split("\n")
    .filter(Boolean)
  const checkpointSet = new Set(meta.untracked)
  let deleted = 0
  for (const rel of nowUntracked) {
    if (!checkpointSet.has(rel)) {
      await rm(join(cwd, rel), { force: true })
      deleted++
    }
  }

  // 3. 快照时存在、现在被改/被删的未跟踪文件 → 还原
  let restored = 0
  for (const rel of meta.untracked) {
    const src = join(dir, "untracked", rel)
    if (existsSync(src)) {
      await mkdir(dirname(join(cwd, rel)), { recursive: true })
      await cp(src, join(cwd, rel), { force: true })
      restored++
    }
  }

  return { deleted, restored, patchApplied: Boolean(patch.trim()) }
}

/** 只留最近 MAX_CHECKPOINTS 个 */
async function pruneCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  const ids = (await readdir(root)).sort()
  while (ids.length > MAX_CHECKPOINTS) {
    await rm(join(root, ids.shift()), { recursive: true, force: true })
  }
}
