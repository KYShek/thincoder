/**
 * checkpoint.mjs — 工作区快照与回滚
 * 快照 = git diff HEAD 补丁 + 未跟踪文件副本（尊重 .gitignore）。
 * 仅 git 仓库内可用。回滚前会先打新快照（回滚可逆）。
 * rewind 支持 path 参数按文件恢复（只还原指定文件）。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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

/** 从 unified diff 提取改动过的跟踪文件列表 */
function trackedFilesFromPatch(patch) {
  if (!patch.trim()) return []
  const files = new Set()
  for (const m of patch.matchAll(/^--- a\/(.+)$/gm)) files.add(m[1])
  return [...files].sort()
}

/** 从 unified diff 提取单个文件的补丁块 */
function extractFileHunks(patch, filePath) {
  // 按文件切分：每个文件块以 "diff --git" 开头
  const sections = patch.split(/(?=^diff --git )/m)
  for (const sec of sections) {
    if (!sec.trim()) continue
    const m = sec.match(/^diff --git a\/(.+) b\/(.+)/m)
    if (!m) continue
    if (m[1] === filePath || m[2] === filePath) return sec.trim()
  }
  return ""
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
  const tracked = trackedFilesFromPatch(patch)

  // 未跟踪文件（尊重 .gitignore）→ 原样复制
  const untrackedRaw = git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? ""
  const untracked = untrackedRaw ? untrackedRaw.split("\n").filter(Boolean) : []
  for (const rel of untracked) {
    const src = join(cwd, rel)
    const dst = join(dir, "untracked", rel)
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(src, dst).catch(() => {}) // 复制失败（socket/设备文件等）跳过
  }

  await writeFile(join(dir, "meta.json"), JSON.stringify({
    id, time: Date.now(), untracked, tracked,
  }, null, 2), "utf8")

  await pruneCheckpoints(cwd)
  return { id, time: Date.now(), files: untracked.length + tracked.length, tracked, untracked }
}

/** 列出快照（新→旧），含文件变更概要 */
export async function listCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  if (!existsSync(root)) return []
  const ids = (await readdir(root)).sort().reverse()
  const out = []
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"))
      // 兼容旧快照（无 tracked 字段）：从补丁文件提取
      const tracked = meta.tracked ?? (() => {
        try {
          return trackedFilesFromPatch(readFileSync(join(root, id, "patch.diff"), "utf8"))
        } catch { return [] }
      })()
      out.push({
        id, time: meta.time,
        untracked: meta.untracked ?? [],
        tracked,
      })
    } catch {
      // 损坏的快照跳过
    }
  }
  return out
}

// ---- 恢复核心 ----

/** 从快照目录完整恢复跟踪文件：reset 到 HEAD → apply 补丁 */
async function fullRestoreTracked(cwd, dir) {
  git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "."])
  const patch = await readFile(join(dir, "patch.diff"), "utf8")
  if (patch.trim()) {
    git(cwd, ["apply", "--whitespace=nowarn", join(dir, "patch.diff")])
  }
  return Boolean(patch.trim())
}

/** 从快照目录完整恢复未跟踪文件：删除新建的 → 还原快照时的 */
async function fullRestoreUntracked(cwd, dir, meta) {
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

  let restored = 0
  for (const rel of meta.untracked) {
    const src = join(dir, "untracked", rel)
    if (existsSync(src)) {
      await mkdir(dirname(join(cwd, rel)), { recursive: true })
      await cp(src, join(cwd, rel), { force: true })
      restored++
    }
  }
  return { deleted, restored }
}

/** 只恢复单个跟踪文件：checkout HEAD → 用该文件的补丁块 apply */
async function partialRestoreTracked(cwd, patchContent, filePath) {
  // 先把文件重置到 HEAD 状态
  git(cwd, ["checkout", "HEAD", "--", filePath], { allowFail: true })
  const hunks = extractFileHunks(patchContent, filePath)
  if (!hunks) return false
  const tmpFile = join(checkpointRoot(cwd), ".tmp_partial.patch")
  await writeFile(tmpFile, hunks, "utf8")
  try {
    git(cwd, ["apply", "--whitespace=nowarn", tmpFile])
    return true
  } finally {
    await rm(tmpFile, { force: true })
  }
}

/** 只恢复单个未跟踪文件 */
async function partialRestoreUntracked(cwd, dir, filePath) {
  const src = join(dir, "untracked", filePath)
  if (!existsSync(src)) return false
  await mkdir(dirname(join(cwd, filePath)), { recursive: true })
  await cp(src, join(cwd, filePath), { force: true })
  return true
}

// ---- 回滚 ----

/**
 * 回滚到指定快照（先把当前状态存成新快照，保证回滚可逆）。
 *
 * 选项：
 * - path: 只恢复这一个文件（跟踪或未跟踪均可）；不删别的文件。
 *   不传则做完整回滚（所有改动 → 快照时状态）。
 *
 * 返回摘要 { patchApplied, deleted?, restored? }，path 模式下含 { file, type }。
 */
export async function rewind(cwd, id, { path } = {}) {
  const root = checkpointRoot(cwd)
  const dir = join(root, id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const patchContent = await readFile(join(dir, "patch.diff"), "utf8")

  // 回滚也可逆：先给当前状态打快照
  const preRewindCp = await createCheckpoint(cwd)

  // ---- 按文件恢复 ----
  if (path) {
    // 判断是跟踪文件还是未跟踪文件
    const isTracked = meta.tracked?.includes(path) ?? extractFileHunks(patchContent, path) !== ""
    const inUntracked = (meta.untracked ?? []).includes(path)

    if (!isTracked && !inUntracked) {
      throw new Error(`file "${path}" not found in checkpoint ${id} (tracked: ${(meta.tracked ?? []).join(", ") || "none"}, untracked: ${(meta.untracked ?? []).join(", ") || "none"})`)
    }

    let ok = false
    if (isTracked) {
      ok = await partialRestoreTracked(cwd, patchContent, path)
    }
    if (inUntracked) {
      ok = await partialRestoreUntracked(cwd, dir, path) || ok
    }

    return { path, type: isTracked ? "tracked" : "untracked", restored: ok, patchApplied: false }
  }

  // ---- 完整回滚 ----
  try {
    const patchApplied = await fullRestoreTracked(cwd, dir)
    const { deleted, restored } = await fullRestoreUntracked(cwd, dir, meta)
    return { deleted, restored, patchApplied }
  } catch (e) {
    // git apply 失败：工作区可能已被 restore 清成 HEAD。
    // 用 pre-rewind 快照恢复现场，保证回滚失败不会丢数据
    const preDir = join(root, preRewindCp.id)
    try {
      await fullRestoreTracked(cwd, preDir)
      await fullRestoreUntracked(cwd, preDir, JSON.parse(await readFile(join(preDir, "meta.json"), "utf8")))
    } catch {
      // 双重失败：pre-rewind 也可能损坏，不再尝试
    }
    throw new Error(
      `Rewind to ${id} failed: ${e.message}. ` +
      `The pre-rewind state was restored from checkpoint ${preRewindCp.id} — no work was lost.`
    )
  }
}

/** 只留最近 MAX_CHECKPOINTS 个 */
async function pruneCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  const ids = (await readdir(root)).sort()
  while (ids.length > MAX_CHECKPOINTS) {
    await rm(join(root, ids.shift()), { recursive: true, force: true })
  }
}
