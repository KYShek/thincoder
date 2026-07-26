/**
 * gitmem.mjs — Team 层记忆的 git 同步
 * 全部通过 child_process 调系统 git，零依赖。
 * 冲突策略（已定）：不同条目天然不冲突；真冲突时中止 rebase 保持仓库干净，
 * 报带手动指引的错误——不做自动合并。
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** 在 dir 下执行 git，失败抛带 stderr 的错误 */
async function git(dir, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: dir, encoding: "utf8" })
    return stdout.trim()
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    const err = new Error(`git ${args.join(" ")} failed: ${detail}`)
    err.gitError = true
    err.stderr = detail
    throw err
  }
}

/** 团队仓库不存在则 clone。返回是否发生了 clone */
export async function ensureClone({ repo, dir }) {
  if (existsSync(join(dir, ".git"))) return false
  await mkdir(dirname(dir), { recursive: true })
  await git(dirname(dir), ["clone", repo, dir])
  return true
}

/**
 * 同步：pull --rebase。远端还是空仓库时直接跳过（首次使用前）。
 * 冲突时中止 rebase（保持仓库干净）并抛带指引的错误。
 * 返回 true=拉取成功（调用方随后 syncDir 重建索引）
 */
export async function pullTeam(dir) {
  // 远端空仓库：没有可拉取的分支（ls-remote 无输出）
  const refs = await git(dir, ["ls-remote", "--heads", "origin"])
  if (!refs) return false

  try {
    await git(dir, ["pull", "--rebase"])
    return true
  } catch (error) {
    if (await hasConflict(dir)) {
      await git(dir, ["rebase", "--abort"]).catch(() => {})
      throw new Error(
        `团队记忆同步冲突：本地与远端修改了同一条目。\n` +
        `请到 ${dir} 手动执行 git pull 解决冲突，然后重新运行 thincoder sync。\n` +
        `（本地仓库已恢复到同步前状态，未丢失任何内容）`,
      )
    }
    throw error
  }
}

/**
 * 提交并推送一个条目文件。push 被拒（远端有新提交）时 pull --rebase 后重试一次；
 * rebase 冲突同样中止并报错。
 */
export async function commitAndPush(dir, filename, message) {
  await git(dir, ["add", filename])
  await git(dir, ["commit", "-m", message])
  try {
    await git(dir, ["push"])
  } catch {
    await pullTeam(dir) // 冲突时这里会抛出带指引的错误
    await git(dir, ["push"])
  }
}

/** 当前是否处于 rebase 冲突状态（存在未合并路径） */
async function hasConflict(dir) {
  try {
    const out = await git(dir, ["status", "--porcelain"])
    // 未合并状态共 7 种：DD AU UD UA DU AA UU——只看 UU/AA/DD 会漏掉带 U 的四种，
    // 漏判就不 abort，仓库留在冲突中间态（与"保持仓库干净"的承诺相悖）
    return out.split("\n").some((l) => l[0] === "U" || l[1] === "U" || l.startsWith("AA") || l.startsWith("DD"))
  } catch {
    return false
  }
}
