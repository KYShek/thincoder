import { join } from "node:path"
import { loadConfig, configPath } from "../config.mjs"
import { createMemory } from "../memory.mjs"
import { teamConfig, gitAuthor } from "./make-agent.mjs"
import { setupWizard } from "./setup-wizard.mjs"
import { askPermission } from "./permission.mjs"

/** 缺 key 时的统一提示 */
function noKeyMessage() {
  return `还没有配置 API key。运行 thincoder 进入 TUI，用 /provider add 和 /provider key 配置；或直接编辑 ${configPath}`
}

/** thincoder distill <transcript-file> [--yes] [--scope=...]
 *  返回退出码：0=成功，1=错误 */
export async function distillCommand(args, exitSoon) {
  const flags = {}
  const positional = []
  for (const a of args) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/)
    if (m) flags[m[1]] = m[2] ?? true
    else positional.push(a)
  }
  const file = positional[0]
  if (!file) {
    console.error("Usage: thincoder distill <transcript-file> [--yes] [--scope=personal|project|team]")
    return 1
  }
  const { readFile } = await import("node:fs/promises")
  const transcript = await readFile(file, "utf8")

  const config = loadConfig()
  let provider = config.provider
  if (!provider.apiKey) {
    if (!process.stdin.isTTY) {
      console.error(noKeyMessage())
      return 1
    }
    provider = await setupWizard()
    if (!provider) {
      return 1
    }
  }
  const memory = createMemory({ dbPath: config.memory.dbPath })
  const team = teamConfig(config)
  const { extractCandidates, saveCandidate } = await import("../distill.mjs")

  console.error("[distill] extracting candidates...")
  let candidates
  try {
    candidates = await extractCandidates(provider, transcript)
  } catch (error) {
    console.error(`[distill] ${error.message}`)
    return 1
  }
  if (candidates.length === 0) {
    console.log("No distillable knowledge found in this session.")
    return 0
  }

  const opts = {
    projectDir: config.memory.projectDir ? join(process.cwd(), config.memory.projectDir) : null,
    team,
    author: gitAuthor(),
  }
  let saved = 0
  for (const c of candidates) {
    if (flags.scope) c.scope = flags.scope
    console.log(`\n--- candidate ---`)
    console.log(`[${c.type}] ${c.title}  (scope: ${c.scope})`)
    console.log(c.content)
    if (c.type === "rule") {
      console.log("(rule 类知识通常建议手动撰写；确认提取吗？)")
    }
    const accept = flags.yes ? true : await askPermission("distill-save", { title: c.title })
    if (!accept) {
      console.log("skipped")
      continue
    }
    const where = await saveCandidate(memory, c, opts)
    console.log(`saved -> ${where}`)
    saved++
  }
  console.log(`\nDistilled ${saved}/${candidates.length} entries.`)
  return 0
}
