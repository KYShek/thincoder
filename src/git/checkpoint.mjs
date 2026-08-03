/**
 * checkpoint.mjs — workspace snapshot and rollback (v2: full-file copies)
 * Snapshot = full copies of changed tracked files + untracked file copies (respects .gitignore).
 * v1 stored only a git diff patch — rewind depended on HEAD being unchanged (a commit after the
 * snapshot made `git apply` fail and the failure recovery chain collapse). v2 copies files, so
 * rewind works regardless of later commits.
 * Only available inside git repos. Rewind creates a new snapshot first (rewind is reversible).
 * rewind supports a path parameter for per-file restore.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { configDir } from "../config.mjs"

const CWD_HASH_LEN = 12

const MAX_CHECKPOINTS = 20

/** Files larger than this are NOT copied (sqlite db, bundles…) — they are recorded as skipped. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** meta.version 2 = full-copy snapshots; 1 = legacy patch-only snapshots */
const META_VERSION = 2

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

/** Copy a file into a snapshot directory, skipping oversized files. Returns true when copied. */
async function copyInto(dir, rel, src, skipped) {
  let size
  try { size = statSync(src).size } catch { return false }
  if (size > MAX_FILE_BYTES) {
    skipped.push(rel)
    return false
  }
  const dst = join(dir, rel)
  await mkdir(dirname(dst), { recursive: true })
  await copyFile(src, dst).catch((e) => console.error(`[checkpoint] skipping ${rel}: ${e.message}`))
  return true
}

/**
 * Create a snapshot. Returns { id, time, files, tracked, untracked, skipped } or null (non-git repo).
 */
export async function createCheckpoint(cwd) {
  if (!isGitRepo(cwd)) return null

  // Random suffix: prevents id collisions for two snapshots in the same millisecond (sorting stays ordered by timestamp prefix)
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
  const dir = join(checkpointRoot(cwd), id)
  await mkdir(join(dir, "files"), { recursive: true })
  await mkdir(join(dir, "untracked"), { recursive: true })

  // v2: full copies of changed tracked files (git apply of a stale patch is the v1 failure mode).
  // The patch is still written for legacy tooling/debugging, but rewind uses the copies.
  const head = git(cwd, ["rev-parse", "HEAD"], { allowFail: true }) ?? ""
  const changedRaw = git(cwd, ["diff", "HEAD", "--name-only", "-z"], { allowFail: true }) ?? ""
  const changed = changedRaw ? changedRaw.split("\0").filter(Boolean) : []
  const trackedAllRaw = git(cwd, ["ls-files", "-z"], { allowFail: true }) ?? ""
  const trackedAll = trackedAllRaw ? trackedAllRaw.split("\0").filter(Boolean) : []
  const patch = git(cwd, ["diff", "HEAD", "--binary"], { allowFail: true }) ?? ""
  await writeFile(join(dir, "patch.diff"), patch, "utf8")

  const skipped = []
  for (const rel of changed) {
    await copyInto(join(dir, "files"), rel, join(cwd, rel), skipped)
  }

  // Untracked files (respects .gitignore) → copy as-is
  const untrackedRaw = git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? ""
  const untracked = untrackedRaw ? untrackedRaw.split("\n").filter(Boolean) : []
  for (const rel of untracked) {
    await copyInto(join(dir, "untracked"), rel, join(cwd, rel), skipped)
  }

  await writeFile(join(dir, "meta.json"), JSON.stringify({
    version: META_VERSION, id, time: Date.now(), untracked, tracked: changed, skipped,
    head, trackedAll,
  }, null, 2), "utf8")

  await pruneCheckpoints(cwd)
  return { id, time: Date.now(), files: changed.length + untracked.length, tracked: changed, untracked, skipped }
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
        skipped: meta.skipped ?? [],
        tracked,
      })
    } catch {
      // Corrupted checkpoint — skip
    }
  }
  return out
}

// ---- restore core ----

/** v1 legacy fallback: reset file to HEAD then apply its patch hunks. */
async function partialRestoreTrackedViaPatch(cwd, root, patchContent, filePath) {
  git(cwd, ["checkout", "HEAD", "--", filePath], { allowFail: true })
  const hunks = extractFileHunks(patchContent, filePath)
  if (!hunks) return false
  const tmpFile = join(root, ".tmp_partial.patch")
  await writeFile(tmpFile, hunks, "utf8")
  try {
    git(cwd, ["apply", "--whitespace=nowarn", tmpFile])
    return true
  } finally {
    await rm(tmpFile, { force: true })
  }
}

/** Restore a single file from a snapshot copy. Returns true when the copy existed. */
async function restoreFromCopy(snapshotDir, rel, cwd) {
  const src = join(snapshotDir, rel)
  if (!existsSync(src)) return false
  await mkdir(dirname(join(cwd, rel)), { recursive: true })
  await cp(src, join(cwd, rel), { force: true })
  return true
}

// ---- rewind ----

/**
 * Rewind to a specific snapshot (saves current state as a new snapshot first, making rewind reversible).
 * v2: tracked files are restored from FULL COPIES — works even if commits happened after the snapshot.
 * Untracked files that appeared AFTER the snapshot are NOT deleted (restore ≠ destroy).
 *
 * Options:
 * - path: restore only this single file (tracked or untracked); other files are left untouched.
 *   Omit for a full rewind (all snapshot files → working tree).
 *
 * Returns summary { restored, skipped?, patchApplied? }; in path mode includes { file, type }.
 */
export async function rewind(cwd, id, { path } = {}) {
  const root = checkpointRoot(cwd)
  const dir = join(root, id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const isV2 = meta.version === META_VERSION
  const patchContent = await readFile(join(dir, "patch.diff"), "utf8")

  // Rewind is reversible: snapshot current state first
  const preRewindCp = await createCheckpoint(cwd)

  // ---- per-file restore ----
  if (path) {
    const tracked = meta.tracked ?? []
    const trackedAll = meta.trackedAll ?? []
    const isTracked = tracked.includes(path) || trackedAll.includes(path) || extractFileHunks(patchContent, path) !== ""
    const inUntracked = (meta.untracked ?? []).includes(path)

    if (!isTracked && !inUntracked) {
      throw new Error(`file "${path}" not found in checkpoint ${id} (tracked: ${tracked.join(", ") || "none"}, untracked: ${(meta.untracked ?? []).join(", ") || "none"})`)
    }

    let ok = false
    if (inUntracked) {
      ok = await restoreFromCopy(join(dir, "untracked"), path, cwd) || ok
    }
    if (isTracked) {
      if (isV2 && existsSync(join(dir, "files", path))) {
        ok = await restoreFromCopy(join(dir, "files"), path, cwd) || ok
      } else if (isV2 && meta.head) {
        // Untouched at snapshot time (content = snapshot HEAD) → checkout that commit's version.
        // Works even if HEAD moved since — the commit object is immutable.
        git(cwd, ["checkout", meta.head, "--", path], { allowFail: true })
        ok = true
      } else {
        // v1 snapshot or skipped (oversized) file → patch fallback
        ok = await partialRestoreTrackedViaPatch(cwd, root, patchContent, path) || ok
      }
    }

    return { path, type: isTracked ? "tracked" : "untracked", restored: ok, patchApplied: !ok }
  }

  // ---- full rewind ----
  let restored = 0
  let patchApplied = false
  const restoredSkipped = []

  try {
    if (isV2) {
      // 1. Untouched tracked files: reset the whole tree to the SNAPSHOT HEAD commit
      //    (content = snapshot state for every tracked file unchanged at snapshot time).
      //    Works even if commits happened after the snapshot — the commit object is immutable.
      if (meta.head) {
        git(cwd, ["checkout", meta.head, "--", "."], { allowFail: true })
        restored += (meta.trackedAll ?? []).filter((f) => !(meta.tracked ?? []).includes(f)).length
      }
      // 2. Changed tracked files: restore from full copies (files deleted since the snapshot come back too)
      for (const rel of meta.tracked ?? []) {
        const src = join(dir, "files", rel)
        if (existsSync(src)) {
          await restoreFromCopy(join(dir, "files"), rel, cwd)
          restored++
        } else if ((meta.skipped ?? []).includes(rel)) {
          restoredSkipped.push(rel)
        } else if (extractFileHunks(patchContent, rel) && await partialRestoreTrackedViaPatch(cwd, root, patchContent, rel)) {
          restored++
          patchApplied = true
        }
      }
      // 3. Untracked: restore snapshot copies (new files created after the snapshot are KEPT — restore ≠ destroy)
      for (const rel of meta.untracked ?? []) {
        if (await restoreFromCopy(join(dir, "untracked"), rel, cwd)) restored++
        else if ((meta.skipped ?? []).includes(rel)) restoredSkipped.push(rel)
      }
    } else {
      // v1 legacy snapshot: reset to HEAD → apply patch (best effort)
      git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "."])
      if (patchContent.trim()) {
        git(cwd, ["apply", "--whitespace=nowarn", join(dir, "patch.diff")])
        patchApplied = true
      }
      restored = (meta.tracked ?? []).length
    }

    const skippedNote = restoredSkipped.length > 0
      ? `\nSkipped (oversized, not snapshotted): ${restoredSkipped.join(", ")}`
      : ""
    return { restored, deleted: 0, patchApplied, skipped: restoredSkipped, skippedNote }
  } catch (e) {
    // Restore failed: revert to the pre-rewind snapshot so no work is lost.
    const preDir = join(root, preRewindCp.id)
    try {
      const preMeta = JSON.parse(await readFile(join(preDir, "meta.json"), "utf8"))
      if (preMeta.version === META_VERSION) {
        for (const rel of preMeta.tracked ?? []) {
          if (existsSync(join(preDir, "files", rel))) await restoreFromCopy(join(preDir, "files"), rel, cwd)
        }
        for (const rel of preMeta.untracked ?? []) {
          if (existsSync(join(preDir, "untracked", rel))) await restoreFromCopy(join(preDir, "untracked"), rel, cwd)
        }
      } else {
        git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "."])
        const prePatch = await readFile(join(preDir, "patch.diff"), "utf8")
        if (prePatch.trim()) git(cwd, ["apply", "--whitespace=nowarn", join(preDir, "patch.diff")])
      }
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
 * v2: read the snapshot copy directly. Legacy snapshots fall back to the temporary-restore path.
 * Returns the file content string.
 */
export async function catFile(cwd, id, filePath) {
  const root = checkpointRoot(cwd)
  const dir = join(root, id)
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`checkpoint ${id} not found`)
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
  const isV2 = meta.version === META_VERSION
  const patchContent = await readFile(join(dir, "patch.diff"), "utf8")

  const tracked = meta.tracked ?? []
  const isTracked = tracked.includes(filePath) || extractFileHunks(patchContent, filePath) !== ""
  const inUntracked = (meta.untracked ?? []).includes(filePath)

  if (!isTracked && !inUntracked) {
    throw new Error(`file "${filePath}" not in checkpoint ${id}`)
  }

  // v2: read the snapshot copy directly
  const copy = join(inUntracked ? join(dir, "untracked") : join(dir, "files"), filePath)
  if (isV2 && existsSync(copy)) {
    return await readFile(copy, "utf8")
  }

  // Untracked legacy: read the copy if present
  if (inUntracked && !isTracked) {
    const src = join(dir, "untracked", filePath)
    if (!existsSync(src)) throw new Error(`untracked file "${filePath}" copy missing in checkpoint`)
    return await readFile(src, "utf8")
  }

  // Tracked legacy: temporarily restore → read → restore working tree
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
