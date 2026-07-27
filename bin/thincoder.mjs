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

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runAgent } from "../src/agent.mjs"
import { loadConfig, configPath } from "../src/config.mjs"
import { createMemory, syncDir } from "../src/memory.mjs"
import { makeAgent, teamConfig, gitAuthor } from "../src/cli/make-agent.mjs"
import { memoryCommand } from "../src/cli/memory-command.mjs"
import { setupWizard } from "../src/cli/setup-wizard.mjs"
import { summarize, askPermission } from "../src/cli/permission.mjs"
import { distillCommand } from "../src/cli/distill-command.mjs"

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

/** 语义化版本比较：a<b 返回 -1，相等 0，a>b 返回 1；非数字段按字符串比 */
function compareVersions(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".")
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] ?? "0", xb = pb[i] ?? "0"
    const na = Number(xa), nb = Number(xb)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1
    }
  }
  return 0
}

switch (command) {
  case "chat": {
    const auto = args.includes("--auto")
    const prompt = args.filter((a) => a !== "--auto").join(" ").trim()
    if (!prompt) {
      console.error('Usage: thincoder chat [--auto] "<prompt>"')
      exitSoon(1)
      break
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
        onWait: ({ phase, seconds }) => {
          console.error(phase === "gate" ? `[rate-limit] TPM 节流等待 ~${seconds}s` : `[rate-limit] 429，${seconds}s 后重试`)
        },
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
    const code = await memoryCommand(memory, args)
    if (code) exitSoon(code)
    break
  }

  case "sync": {
    const config = loadConfig()
    const team = teamConfig(config)
    if (!team) {
      console.error("Team memory not configured. Set memory.team in ~/.thincoder/config.json:")
      console.error('  "team": { "name": "myteam", "repo": "git@github.com:org/team-memory.git" }')
      exitSoon(1)
      break
    }
    const memory = createMemory({ dbPath: config.memory.dbPath })
    const { ensureClone, pullTeam } = await import("../src/git/gitmem.mjs")
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
    const code = await distillCommand(args, exitSoon)
    if (code) exitSoon(code)
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
      const { ensureClone } = await import("../src/git/gitmem.mjs")
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
    const { execSync } = await import("node:child_process")
    let remote
    try {
      remote = execSync("npm view thincoder version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      console.error("[upgrade] 无法查询 npm registry，请确认网络和 npm 已安装")
      exitSoon(1)
      break
    }
    if (compareVersions(local, remote) >= 0) {
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
