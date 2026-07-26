#!/usr/bin/env node

/**
 * thincoder — 命令入口
 *   thincoder                 启动 TUI
 *   thincoder chat "..."      一次性 agent 问答（可调用工具，流式输出）
 *   thincoder memory <sub>    记忆管理：list / search / put / remove
 *   thincoder upgrade         从 npm 升级到最新版
 *   thincoder -v              显示版本号
 *   thincoder --help          显示帮助
 */

import { existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { createAgent, runAgent } from "../src/agent.mjs"
import { loadConfig, saveConfig, configDir, configPath, PROVIDER_PRESETS } from "../src/config.mjs"
import { createMemory, memoryTools, put, remove, search, list, syncDir, codeSearchTool, docSearchTool } from "../src/memory.mjs"
import { repoOutlineTool } from "../src/repomap.mjs"
import { builtinTools } from "../src/tools.mjs"

const [command, ...args] = process.argv.slice(2)
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

// 顶层兜底：任何未捕获错误打印一行消息干净退出，不糊用户一脸 stack
process.on("uncaughtException", (error) => {
  console.error(`[error] ${error.message}`)
  exitSoon(1)
})
process.on("unhandledRejection", (error) => {
  console.error(`[error] ${error?.message ?? error}`)
  exitSoon(1)
})

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
  thincoder upgrade         Update to the latest version from npm
  thincoder -v, --version   Print version

Config: ~/.thincoder/config.json (providers[] + activeProvider；TUI 内用 /provider、/model 管理)
Env:    THINCODER_API_KEY, THINCODER_BASE_URL, THINCODER_MODEL, THINCODER_ACTIVE_PROVIDER
`

/** 缺 key 时的统一提示 */
function noKeyMessage() {
  return `还没有配置 API key。运行 thincoder 进入 TUI，用 /provider add 和 /provider key 配置；或直接编辑 ${configPath}`
}

/** 延迟退出：fetch 后立刻 process.exit 在 Windows/Node 24 会触发 libuv 断言，让一句柄关完再走 */
function exitSoon(code) {
  setTimeout(() => process.exit(code), 100)
}

/** 组装一个带记忆的 agent（同步各层索引后返回） */
async function makeAgent() {
  const config = loadConfig()
  const provider = config.provider
  const providers = config.providersList
  const memory = createMemory({ dbPath: config.memory.dbPath })
  // 向量检索：配了 embedding 就启用（惰性生成向量，首次搜索时补算）
  if (config.embedding?.apiKey) {
    const { createEmbedder } = await import("../src/embedding.mjs")
    memory.embedder = createEmbedder(config.embedding)
  }
  const cwd = process.cwd()
  // code/doc 索引按 origin（项目根目录）隔离：检索只查本项目
  memory.codeOrigin = cwd
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
  const baseTools = [...builtinTools, ...memoryTools(memory, { cwd, projectDir: config.memory.projectDir, author: gitAuthor(), team }), codeSearchTool(memory), docSearchTool(memory), repoOutlineTool(memory.db, cwd)]

  // MCP servers：并行连接（一个死 server 不会拖住启动），失败的收集警告（TUI 下 stderr 不可见，通过 agent 对象传递）
  const mcpServers = config.mcp?.servers ?? []
  let mcpTools = []
  const mcpWarnings = []
  if (mcpServers.length) {
    const { connectMcpServer } = await import("../src/mcp.mjs")
    const results = await Promise.allSettled(mcpServers.map((srv) => connectMcpServer(srv)))
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "fulfilled") {
        mcpTools = mcpTools.concat(r.value)
      } else {
        const srv = mcpServers[i]
        const msg = `MCP server "${srv.name ?? srv.command}" failed to connect: ${r.reason?.message ?? r.reason}`
        console.error(`[mcp] ${msg}`)
        mcpWarnings.push(msg)
      }
    }
  }

  const agent = createAgent({
    provider,
    tools: [...baseTools, ...mcpTools],
    config,
    cwd,
    memory,
  })
  agent.providers = providers
  agent.activeProvider = config.activeProvider
  agent._mcpWarnings = mcpWarnings
  return agent
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
      exitSoon(1)
    }

    const agent = await makeAgent()
    if (!agent.provider.apiKey) {
      if (!process.stdin.isTTY) {
        console.error(noKeyMessage())
        exitSoon(1)
        break
      }
      const p = await setupWizard()
      if (!p) {
        exitSoon(1)
        break
      }
      agent.provider = p
      agent.activeProvider = p.name
      // 向导可能配了 embedding key：挂上向量检索
      const fresh = loadConfig()
      if (fresh.embedding?.apiKey && agent.memory && !agent.memory.embedder) {
        const { createEmbedder } = await import("../src/embedding.mjs")
        agent.memory.embedder = createEmbedder(fresh.embedding)
      }
    }
    if (auto) agent.autoApprove = true
    // 累计 token 用量，结束时输出到 stderr（不污染 stdout 管道）
    const usageTotal = { prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }
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
        onCompress: () => console.error(`\n[context] 上下文过长，已自动压缩（早期对话由 LLM 摘要）`),
        onTaskUpdate: (items) => {
          const done = items.filter((i) => i.status === "done").length
          const current = items.find((i) => i.status === "in_progress")
          console.error(`[task] ${done}/${items.length}${current ? ` ▶ ${current.title}` : ""}`)
        },
        onUsage: (usage) => {
          usageTotal.prompt += usage.prompt_tokens ?? 0
          usageTotal.completion += usage.completion_tokens ?? 0
          usageTotal.cacheHit += usage.prompt_cache_hit_tokens ?? 0
          usageTotal.cacheMiss += usage.prompt_cache_miss_tokens ?? 0
        },
        onPermissionRequest: (name, toolArgs) => (agent.autoApprove ? true : askPermission(name, toolArgs)),
      })
      process.stdout.write("\n")
      if (usageTotal.prompt > 0) {
        const cacheTotal = usageTotal.cacheHit + usageTotal.cacheMiss
        const hitPart = cacheTotal > 0 ? ` cache-hit ${Math.round((usageTotal.cacheHit / cacheTotal) * 100)}%` : ""
        console.error(`[usage] prompt ${usageTotal.prompt} + completion ${usageTotal.completion}${hitPart}`)
      }
    } catch (error) {
      // 用 name 判断而非 instanceof：不依赖"与 runAgent 同一个模块实例"这一隐式约定
      if (error.name === "ContinueError") {
        console.error(`\n[paused] Agent stopped after ${error.turn} turns. Run in TUI to continue.`)
        exitSoon(0)
      } else {
        console.error(`\n[error] ${error.message}`)
        exitSoon(1)
      }
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
      exitSoon(1)
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
      exitSoon(1)
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
      exitSoon(1)
    }
    const { readFile } = await import("node:fs/promises")
    const transcript = await readFile(file, "utf8")

    const config = loadConfig()
    let provider = config.provider
    if (!provider.apiKey) {
      if (!process.stdin.isTTY) {
        console.error(noKeyMessage())
        exitSoon(1)
        break
      }
      provider = await setupWizard()
      if (!provider) {
        exitSoon(1)
        break
      }
    }
    const memory = createMemory({ dbPath: config.memory.dbPath })
    const team = teamConfig(config)
    const { extractCandidates, saveCandidate } = await import("../src/distill.mjs")

    console.error("[distill] extracting candidates...")
    let candidates
    try {
      candidates = await extractCandidates(provider, transcript)
    } catch (error) {
      console.error(`[distill] ${error.message}`)
      exitSoon(1)
      break
    }
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
    // 恢复上次的会话（同一项目目录）；provider 按保存的名字切回（用户上次可能换过模型）
    const { loadSession, applySession } = await import("../src/session.mjs")
    const restored = loadSession(process.cwd())
    if (restored) {
      const switched = applySession(agent, restored)
      if (switched && agent.config?.agent?.compactThresholdAuto) {
        // 压缩阈值跟模型走（与 TUI 切换 provider 时的处理一致）
        const { resolveCompactThreshold } = await import("../src/config.mjs")
        agent.config.agent.compactThreshold = resolveCompactThreshold(null, agent.provider.model).value
      }
    }
    // MCP 连接失败在 TUI alt-buffer 下 stderr 不可见，注入为下一条 user 消息后的提醒
    if (agent._mcpWarnings?.length) {
      agent._pendingReminders = agent._pendingReminders ?? []
      agent._pendingReminders.push(
        `[System reminder: ${agent._mcpWarnings.length} MCP server(s) failed to connect at startup:\n` +
        agent._mcpWarnings.map((w) => `  - ${w}`).join("\n") +
        `\nYou can try reconnecting with /mcp connect <name>.]`
      )
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
      exitSoon(1)
    }
    break
  }

  case "upgrade": {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    const local = pkg.version
    let remote
    try {
      remote = execSync("npm view thincoder version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      console.error("[upgrade] 无法查询 npm registry，请确认网络和 npm 已安装")
      exitSoon(1)
    }
    if (remote === local) {
      console.log(`ThinCoder ${local} 已是最新。`)
    } else {
      console.log(`升级: ${local} → ${remote}`)
      execSync("npm install -g thincoder@latest", { stdio: "inherit" })
      console.log(`已升级到 ${remote}`)
    }
    break
  }

  case "--help":
  case "-h": {
    process.stdout.write(USAGE)
    break
  }

  case "--version":
  case "-v": {
    console.log(VERSION)
    break
  }

  default: {
    console.error(`Unknown command: ${command}\n`)
    process.stdout.write(USAGE)
    exitSoon(1)
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
        exitSoon(1)
      }
      printEntries(await search(memory, query, { limit: 10 }))
      break
    }
    case "put": {
      if (!flags.type || !flags.title || !flags.content) {
        console.error("Usage: thincoder memory put --type=<rule|knowledge|decision|pattern> --title=<t> --content=<c> [--tags=<t>]")
        exitSoon(1)
      }
      const id = await put(memory, { type: flags.type, title: flags.title, content: flags.content, tags: flags.tags ?? "" })
      console.log(`Saved (id=${id})`)
      break
    }
    case "remove": {
      const id = Number(positional[0])
      if (!id) {
        console.error("Usage: thincoder memory remove <id>")
        exitSoon(1)
      }
      console.log((await remove(memory, id)) ? `Removed #${id}` : `No entry #${id}`)
      break
    }
    default:
      console.error("Usage: thincoder memory <list|search|put|remove>")
      exitSoon(1)
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

/** 权限请求的关键信息（按工具定制），与 TUI 的 formatPermission 对齐。name 可能带子 agent 前缀（"coder/bash"），取基名匹配 */
function formatPermission(name, args) {
  const cap = (s, n = 1000) => (s.length > n ? `${s.slice(0, n)}…(共 ${s.length} 字符)` : s)
  const base = name.includes("/") ? name.split("/").pop() : name
  if (base === "bash") return cap(args.command ?? "")
  if (base === "write") return `${args.path}（写入 ${(args.content ?? "").length} 字符）\n${cap(args.content ?? "", 1000)}`
  if (base === "edit") {
    const oldLines = cap(args.old_string ?? "", 500).split("\n").map((l) => `- ${l}`).join("\n")
    const newLines = cap(args.new_string ?? "", 500).split("\n").map((l) => `+ ${l}`).join("\n")
    return `${args.path}\n${oldLines}\n  ↓\n${newLines}`
  }
  if (base === "delete") return `${args.path}${args.force ? "（force：跟踪文件也删）" : ""}`
  if (base === "subagent") return cap(args.task ?? "", 500)
  if (base === "memory_put") return `[${args.type ?? ""}] ${args.title ?? ""}\n${cap(args.content ?? "", 500)}`
  return cap(summarize(args), 300)
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
      rl.question(`\n[allow?] ${name}\n${formatPermission(name, toolArgs)}\n(y/N) `, resolve)
    })
    return answer.trim().toLowerCase() === "y"
  } finally {
    rl.close()
  }
}

/** 首次使用（TTY 下的 chat/distill）：问答式配置一个 provider 并落盘，返回运行时 provider；取消返回 null */
async function setupWizard() {
  // 自带缓冲的提问器：rl.question 在输入被管道/快速粘贴时会丢行（问题注册前 line 已到达）
  const rl = createInterface({ input: process.stdin, terminal: false })
  const buffered = []
  let waiter = null
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      buffered.push(line)
    }
  })
  const ask = (q) =>
    new Promise((resolve) => {
      process.stderr.write(q)
      if (buffered.length) resolve(buffered.shift())
      else waiter = resolve
    })
  try {
    const presets = Object.entries(PROVIDER_PRESETS)
    console.error("首次使用，先配置一个模型提供商：")
    presets.forEach(([n, p], i) => console.error(`  ${i + 1}. ${n.padEnd(10)} ${p.desc}`))
    console.error(`  ${presets.length + 1}. 自定义端点`)
    const choice = Number((await ask(`选择 [1-${presets.length + 1}]: `)).trim())
    let name, baseURL, model
    if (choice === presets.length + 1) {
      name = (await ask("名称（如 my-openai）: ")).trim()
      baseURL = (await ask("baseURL（如 https://api.openai.com/v1）: ")).trim().replace(/\/+$/, "")
      model = (await ask("模型（如 gpt-4o）: ")).trim()
      if (!name || !/^https?:\/\//.test(baseURL) || !model) {
        console.error("输入不完整或 baseURL 不合法，已取消")
        return null
      }
    } else if (choice >= 1 && choice <= presets.length) {
      name = presets[choice - 1][0]
      baseURL = presets[choice - 1][1].baseURL
      model = presets[choice - 1][1].model
    } else {
      console.error("无效选择，已取消")
      return null
    }
    const apiKey = (await ask(`${name} 的 API key: `)).trim()
    if (!apiKey) {
      console.error("key 不能为空，已取消")
      return null
    }
    const embedKey = (await ask("可选：embedding API key（SiliconFlow，向量检索用；回车跳过）: ")).trim()
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    const providers = raw.providers?.length ? raw.providers : []
    const existing = providers.find((p) => p.name === name)
    if (existing) Object.assign(existing, { baseURL, model, apiKey })
    else providers.push({ name, baseURL, model, apiKey })
    raw.providers = providers
    raw.activeProvider = name
    if (embedKey) raw.embedding = { ...(raw.embedding ?? {}), apiKey: embedKey }
    saveConfig(raw)
    console.error(`配置完成：${name} / ${model}（已写入 ${configPath}）`)
    console.error(embedKey ? "向量检索已启用\n" : "（未配 embedding key：记忆为纯文本检索，之后在 config.json 的 embedding.apiKey 补上即可开启向量检索）\n")
    return { name, baseURL, model, apiKey }
  } finally {
    rl.close()
  }
}
