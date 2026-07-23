#!/usr/bin/env node

/**
 * thincoder — 命令入口
 *   thincoder                 启动 TUI
 *   thincoder chat "..."      一次性 agent 问答（可调用工具，流式输出）
 *   thincoder memory <sub>    记忆管理：list / search / put / remove
 *   thincoder --help          显示帮助
 */

import { createInterface } from "node:readline"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { createAgent, runAgent } from "../src/agent.mjs"
import { loadConfig, configDir } from "../src/config.mjs"
import { createMemory, memoryTools, put, remove, search, list, syncDir } from "../src/memory.mjs"
import { createProvider } from "../src/provider.mjs"
import { builtinTools } from "../src/tools.mjs"

const [command, ...args] = process.argv.slice(2)

const USAGE = `thincoder - thin coding agent

Usage:
  thincoder                 Launch the interactive TUI
  thincoder chat <prompt>   One-shot agent run (tools enabled), streams reply to stdout
  thincoder memory list [--type=<t>]           List memory entries
  thincoder memory search <query>              Search memory
  thincoder memory put --type=<t> --title=<t> --content=<c> [--tags=<t>]
  thincoder memory remove <id>                 Remove an entry
  thincoder sync              Sync team memory repo (pull --rebase + reindex)
  thincoder reindex           Rebuild the local index from markdown sources
  thincoder distill <file> [--yes] [--scope=<s>]
                            Extract knowledge candidates from a session
                            transcript file; confirm each before saving
  thincoder --help          Show this help

Config: ~/.thincoder/config.json (provider.baseURL / provider.apiKey / provider.model)
Env:    THINCODER_API_KEY, THINCODER_BASE_URL, THINCODER_MODEL
`

/** 组装一个带记忆的 agent（同步各层索引后返回） */
async function makeAgent() {
  const config = loadConfig()
  const provider = createProvider(config.provider)
  const memory = createMemory({ dbPath: config.memory.dbPath })
  // 向量检索：配了 embedding 就启用（惰性生成向量，首次搜索时补算）
  if (config.embedding?.apiKey) {
    const { createEmbedder } = await import("../src/embedding.mjs")
    memory.embedder = createEmbedder(config.embedding)
  }
  const cwd = process.cwd()
  // Project 层：启动时同步 .thincoder/memory/ 目录到索引（有就同步，没有就跳过）
  if (config.memory.projectDir) {
    memory.projectOrigin = join(cwd, config.memory.projectDir)
    await syncDir(memory, { layer: "project", dir: memory.projectOrigin })
  }
  // Team 层（可选）：首次自动 clone；启动只索引本地目录，拉取远端走显式 thincoder sync
  const team = teamConfig(config)
  if (team) {
    const { ensureClone } = await import("../src/gitmem.mjs")
    await ensureClone(team)
    await syncDir(memory, { layer: "team", dir: team.dir })
  }
  return createAgent({
    provider,
    tools: [...builtinTools, ...memoryTools(memory, { cwd, projectDir: config.memory.projectDir, author: gitAuthor(), team })],
    config,
    cwd,
    memory,
  })
}

/** 读取 team 配置并补全默认目录；未配置返回 null */
function teamConfig(config) {
  const team = config.memory?.team
  if (!team?.repo) return null
  const name = team.name ?? "default"
  return { name, repo: team.repo, dir: team.dir ?? join(configDir, "teams", name) }
}

/** 条目作者：git config user.name 兜底 unknown */
function gitAuthor() {
  try {
    return execSync("git config user.name", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

switch (command) {
  case "chat": {
    const auto = args.includes("--auto")
    const prompt = args.filter((a) => a !== "--auto").join(" ").trim()
    if (!prompt) {
      console.error('Usage: thincoder chat [--auto] "<prompt>"')
      process.exit(1)
    }

    const agent = await makeAgent()
    if (auto) agent.autoApprove = true
    try {
      await runAgent(agent, prompt, {
        onToken: (text) => process.stdout.write(text),
        onToolCall: (name, toolArgs) => {
          console.error(`\n[tool] ${name} ${summarize(toolArgs)}`)
        },
        onToolResult: (name, result) => {
          const preview = result.length > 200 ? result.slice(0, 200) + "..." : result
          console.error(`[done] ${name} -> ${preview.split("\n")[0]}`)
        },
        onToolOutput: (name, chunk) => process.stderr.write(chunk),
        onPermissionRequest: (name, toolArgs) => (agent.autoApprove ? true : askPermission(name, toolArgs)),
      })
      process.stdout.write("\n")
    } catch (error) {
      console.error(`\n[error] ${error.message}`)
      process.exit(1)
    }
    break
  }

  case "memory": {
    const config = loadConfig()
    const memory = createMemory({ dbPath: config.memory.dbPath })
    if (config.embedding?.apiKey) {
      const { createEmbedder } = await import("../src/embedding.mjs")
      memory.embedder = createEmbedder(config.embedding)
    }
    if (config.memory.projectDir) {
      memory.projectOrigin = join(process.cwd(), config.memory.projectDir)
    }
    await memoryCommand(memory, args)
    break
  }

  case "sync": {
    const config = loadConfig()
    const team = teamConfig(config)
    if (!team) {
      console.error("Team memory not configured. Set memory.team in ~/.thincoder/config.json:")
      console.error('  "team": { "name": "myteam", "repo": "git@github.com:org/team-memory.git" }')
      process.exit(1)
    }
    const memory = createMemory({ dbPath: config.memory.dbPath })
    const { ensureClone, pullTeam } = await import("../src/gitmem.mjs")
    try {
      const cloned = await ensureClone(team)
      if (cloned) console.log(`Cloned team repo to ${team.dir}`)
      await pullTeam(team.dir)
      const stats = await syncDir(memory, { layer: "team", dir: team.dir })
      console.log(`Synced. Index: +${stats.added} ~${stats.updated} -${stats.removed}`)
    } catch (error) {
      console.error(`[error] ${error.message}`)
      process.exit(1)
    }
    break
  }

  case "distill": {
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
      process.exit(1)
    }
    const { readFile } = await import("node:fs/promises")
    const transcript = await readFile(file, "utf8")

    const config = loadConfig()
    const provider = createProvider(config.provider)
    const memory = createMemory({ dbPath: config.memory.dbPath })
    const team = teamConfig(config)
    const { extractCandidates, saveCandidate } = await import("../src/distill.mjs")

    console.error("[distill] extracting candidates...")
    const candidates = await extractCandidates(provider, transcript)
    if (candidates.length === 0) {
      console.log("No distillable knowledge found in this session.")
      break
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
    break
  }

  case "reindex": {
    const config = loadConfig()
    const memory = createMemory({ dbPath: config.memory.dbPath })
    // files 层（project/team 的 markdown 索引）全量重建；索引是易失品，真相在 markdown
    memory.db.prepare(`DELETE FROM files`).run()
    const cwd = process.cwd()
    let total = { added: 0, removed: 0 }
    if (config.memory.projectDir) {
      const s = await syncDir(memory, { layer: "project", dir: join(cwd, config.memory.projectDir) })
      total.added += s.added
    }
    const team = teamConfig(config)
    if (team) {
      const { ensureClone } = await import("../src/gitmem.mjs")
      await ensureClone(team)
      const s = await syncDir(memory, { layer: "team", dir: team.dir })
      total.added += s.added
    }
    console.log(`Reindexed ${total.added} markdown entries (project${team ? " + team" : ""}). Vectors will be lazily regenerated on next search.`)
    break
  }

  case "tui":
  case undefined: {
    const agent = await makeAgent()
    const config = loadConfig()
    // 恢复上次的会话（同一项目目录）
    const { loadSession } = await import("../src/session.mjs")
    const restored = loadSession(process.cwd())
    if (restored) {
      agent.history = restored.history
      agent.tasks = restored.tasks ?? []
    }
    const { startTUI } = await import("../src/tui.mjs")
    try {
      await startTUI(agent, {
        projectDir: config.memory.projectDir ? join(process.cwd(), config.memory.projectDir) : null,
        team: teamConfig(config),
        author: gitAuthor(),
        restored,
      })
    } catch (error) {
      console.error(`[error] ${error.message}`)
      process.exit(1)
    }
    break
  }

  case "--help":
  case "-h": {
    process.stdout.write(USAGE)
    break
  }

  default: {
    console.error(`Unknown command: ${command}\n`)
    process.stdout.write(USAGE)
    process.exit(1)
  }
}

// ---------------------------------------------------------------- memory 子命令

async function memoryCommand(memory, args) {
  const [sub, ...rest] = args

  const flags = {}
  const positional = []
  for (const a of rest) {
    const m = a.match(/^--([\w-]+)=(.*)$/)
    if (m) flags[m[1]] = m[2]
    else positional.push(a)
  }

  switch (sub) {
    case "list": {
      const entries = await list(memory, { type: flags.type })
      printEntries(entries)
      break
    }
    case "search": {
      const query = positional.join(" ")
      if (!query) {
        console.error("Usage: thincoder memory search <query>")
        process.exit(1)
      }
      printEntries(await search(memory, query, { limit: 10 }))
      break
    }
    case "put": {
      if (!flags.type || !flags.title || !flags.content) {
        console.error("Usage: thincoder memory put --type=<rule|knowledge|decision|pattern> --title=<t> --content=<c> [--tags=<t>]")
        process.exit(1)
      }
      const id = await put(memory, { type: flags.type, title: flags.title, content: flags.content, tags: flags.tags ?? "" })
      console.log(`Saved (id=${id})`)
      break
    }
    case "remove": {
      const id = Number(positional[0])
      if (!id) {
        console.error("Usage: thincoder memory remove <id>")
        process.exit(1)
      }
      console.log((await remove(memory, id)) ? `Removed #${id}` : `No entry #${id}`)
      break
    }
    default:
      console.error("Usage: thincoder memory <list|search|put|remove>")
      process.exit(1)
  }
}

function printEntries(entries) {
  if (entries.length === 0) {
    console.log("(no entries)")
    return
  }
  for (const e of entries) {
    console.log(`#${e.id} [${e.type}] ${e.title}${e.tags ? `  (${e.tags})` : ""}`)
    console.log(`  ${e.content.split("\n")[0].slice(0, 100)}`)
  }
}

// ---------------------------------------------------------------- 工具函数

function summarize(toolArgs) {
  const s = JSON.stringify(toolArgs)
  return s.length > 120 ? s.slice(0, 120) + "..." : s
}

/** 权限确认：TTY 下交互询问 y/n；非交互环境默认拒绝（安全优先） */
async function askPermission(name, toolArgs) {
  if (!process.stdin.isTTY) {
    console.error(`\n[deny] ${name} (non-interactive, side-effect tools require a TTY)`)
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`\n[allow?] ${name} ${summarize(toolArgs)} (y/N) `, resolve)
    })
    return answer.trim().toLowerCase() === "y"
  } finally {
    rl.close()
  }
}
