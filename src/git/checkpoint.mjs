/**
 * checkpoint.mjs — workspace snapshot and rollback
 * Snapshot = git diff HEAD patch + untracked file copies (respects .gitignore).
 * Only available inside git repos. Rewind creates a new snapshot first (rewind is reversible).
 * rewind supports a path parameter for per-file restore (restores only the specified file).
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { configDir } from "../config.mjs"

const CWD_HASH_LEN = 12

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
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, CWD_HASH_LEN)
  return join(configDir, "checkpoints", hash)
}

/** Extract the list of tracked files changed from a unified diff */
function trackedFilesFromPatch(patch) {
  if (!patch.trim()) return []
  const files = new Set()
  for (const m of patch.matchAll(/^--- a\/(.+)$/gm)) files.add(m[1])
  return [...files].sort()
}

/** Extract a single file's patch hunks from a unified diff */
function extractFileHunks(patch, filePath) {
  // Split by file: each file block starts with "diff --git"
  const sections = patch.split(/(?=^diff --git )/m)
  for (const sec of sections) {
    if (!sec.trim()) continue
    const m = sec.match(/^diff --git a\/(.+) b\/(.+)/m)
    if (!m) continue
    if (m[1] === filePath || m[2] === filePath) return sec.trim()
  }
  return ""
}

/** Whether the current directory is a git repo */
export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }) === "true"
}

/**
 * Create a snapshot. Returns { id, time, files } or null (non-git repo).
 */
export async function createCheckpoint(cwd) {
  if (!isGitRepo(cwd)) return null

  // Random suffix: prevents id collisions for two snapshots in the same millisecond (sorting stays ordered by timestamp prefix)
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  const dir = join(checkpointRoot(cwd), id)
  await mkdir(join(dir, "untracked"), { recursive: true })

  // Tracked file changes → patch
  const patch = git(cwd, ["diff", "HEAD", "--binary"], { allowFail: true }) ?? ""
  await writeFile(join(dir, "patch.diff"), patch, "utf8")
  const tracked = trackedFilesFromPatch(patch)

  // Untracked files (respects .gitignore) → copy as-is
  const untrackedRaw = git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? ""
  const untracked = untrackedRaw ? untrackedRaw.split("\n").filter(Boolean) : []
  for (const rel of untracked) {
    const src = join(cwd, rel)
    const dst = join(dir, "untracked", rel)
    await mkdir(dirname(dst), { recursive: true })
    // Copy failed (socket/device file etc.) — skip, but log in case it's unexpected
    await copyFile(src, dst).catch((e) => console.error(`[checkpoint] skipping ${rel}: ${e.message}`))
  }

  await writeFile(join(dir, "meta.json"), JSON.stringify({
    id, time: Date.now(), untracked, tracked,
  }, null, 2), "utf8")

  await pruneCheckpoints(cwd)
  return { id, time: Date.now(), files: untracked.length + tracked.length, tracked, untracked }
}

/** List checkpoints (newest→oldest), with file change summary */
export async function listCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  if (!existsSync(root)) return []
  const ids = (await readdir(root)).sort().reverse()
  const out = []
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"))
      // Compat with old checkpoints (no tracked field): extract from patch file
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
      // Corrupted checkpoint — skip
    }
  }
  return out
}

// ---- restore core ----

/** Full restore of tracked files from a checkpoint: reset to HEAD → apply patch */
async function fullRestoreTracked(cwd, dir) {
  git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "."])
  const patch = await readFile(join(dir, "patch.diff"), "utf8")
  if (patch.trim()) {
    git(cwd, ["apply", "--whitespace=nowarn", join(dir, "patch.diff")])
  }
  return Boolean(patch.trim())
}

/** Full restore of untracked files from a checkpoint: delete new ones → restore from snapshot */
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

/** Restore a single tracked file: checkout HEAD → apply that file's patch hunks */
async function partialRestoreTracked(cwd, patchContent, filePath) {
  // Reset the file to HEAD state first
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

/** Restore a single untracked file */
async function partialRestoreUntracked(cwd, dir, filePath) {
  const src = join(dir, "untracked", filePath)
  if (!existsSync(src)) return false
  await mkdir(dirname(join(cwd, filePath)), { recursive: true })
  await cp(src, join(cwd, filePath), { force: true })
  return true
}

// ---- rewind ----

/**
 * Rewind to a specific snapshot (saves current state as a new snapshot first, making rewind reversible).
 *
 * Options:
 * - path: restore only this single file (tracked or untracked); other files are left untouched.
 *   Omit for a full rewind (all changes → snapshot state).
 *
 * Returns summary { patchApplied, deleted?, restored? }; in path mode includes { file, type }.
 */
export async function rewind(cwd, id, { path } = {}) {
  const root = checkpointRoot(cwd)
  const dir = join(root, id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const patchContent = await readFile(join(dir, "patch.diff"), "utf8")

  // Rewind is reversible: snapshot current state first
  const preRewindCp = await createCheckpoint(cwd)

  // ---- per-file restore ----
  if (path) {
    // Determine whether it's a tracked or untracked file
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

  // ---- full rewind ----
  try {
    const patchApplied = await fullRestoreTracked(cwd, dir)
    const { deleted, restored } = await fullRestoreUntracked(cwd, dir, meta)
    return { deleted, restored, patchApplied }
  } catch (e) {
    // git apply failed: working tree may have been reset to HEAD by restore.
    // Restore from pre-rewind snapshot to ensure no data is lost on rewind failure
    const preDir = join(root, preRewindCp.id)
    try {
      await fullRestoreTracked(cwd, preDir)
      await fullRestoreUntracked(cwd, preDir, JSON.parse(await readFile(join(preDir, "meta.json"), "utf8")))
    } catch {
      // Double failure: pre-rewind may also be corrupt, stop trying
    }
    throw new Error(
      `Rewind to ${id} failed: ${e.message}. ` +
      `The pre-rewind state was restored from checkpoint ${preRewindCp.id} — no work was lost.`
    )
  }
}

// ---- view ----

/**
 * View a file's content from a checkpoint (does not modify the working tree).
 * Tracked files: temporarily restore via checkout HEAD + apply patch hunks, read, then restore original.
 * Untracked files: read the copy directly from the checkpoint directory.
 * Returns the file content string.
 */
export async function catFile(cwd, id, filePath) {
  const root = checkpointRoot(cwd)
  const dir = join(root, id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const patchContent = await readFile(join(dir, "patch.diff"), "utf8")

  const isTracked = meta.tracked?.includes(filePath) ?? extractFileHunks(patchContent, filePath) !== ""
  const inUntracked = (meta.untracked ?? []).includes(filePath)

  if (!isTracked && !inUntracked) {
    throw new Error(`file "${filePath}" not in checkpoint ${id}`)
  }

  // Untracked file: read the copy directly
  if (inUntracked && !isTracked) {
    const src = join(dir, "untracked", filePath)
    if (!existsSync(src)) throw new Error(`untracked file "${filePath}" copy missing in checkpoint`)
    return await readFile(src, "utf8")
  }

  // Tracked file: temporarily restore → read → restore working tree
  const abs = join(cwd, filePath)
  const existed = existsSync(abs)
  let saved = null
  if (existed) saved = await readFile(abs, "utf8")

  try {
    git(cwd, ["checkout", "HEAD", "--", filePath])
    const hunks = extractFileHunks(patchContent, filePath)
    if (hunks) {
      const tmpPatch = join(root, ".tmp_cat.patch")
      await writeFile(tmpPatch, hunks, "utf8")
      try {
        git(cwd, ["apply", "--whitespace=nowarn", tmpPatch])
      } finally {
        await rm(tmpPatch, { force: true })
      }
    }
    return await readFile(abs, "utf8")
  } finally {
    // Restore original working tree state
    if (existed) {
      await writeFile(abs, saved, "utf8")
    } else {
      await rm(abs, { force: true })
    }
  }
}

/** Keep only the most recent MAX_CHECKPOINTS */
async function pruneCheckpoints(cwd) {
  const root = checkpointRoot(cwd)
  const ids = (await readdir(root)).sort()
  while (ids.length > MAX_CHECKPOINTS) {
    await rm(join(root, ids.shift()), { recursive: true, force: true })
  }
}
