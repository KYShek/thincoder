#!/usr/bin/env node

/**
 * thincoder — 命令入口
 *   thincoder                 启动 TUI
 *   thincoder chat "..."      一次性 agent 问答（可调用工具，流式输出）
 *   thincoder memory <sub>    记忆管理：list / search / put / remove
 *   thincoder --help          显示帮助
 */

import { createInterface } from "node:readline"
import { createAgent, runAgent } from "../src/agent.mjs"
import { loadConfig } from "../src/config.mjs"
import { createMemory, memoryTools, put, remove, search, list } from "../src/memory.mjs"
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
  thincoder --help          Show this help

Config: ~/.thincoder/config.json (provider.baseURL / provider.apiKey / provider.model)
Env:    THINCODER_API_KEY, THINCODER_BASE_URL, THINCODER_MODEL
`

/** 组装一个带记忆的 agent */
function makeAgent() {
  const config = loadConfig()
  const provider = createProvider(config.provider)
  const memory = createMemory({ dbPath: config.memory.dbPath })
  return createAgent({
    provider,
    tools: [...builtinTools, ...memoryTools(memory)],
    config,
    cwd: process.cwd(),
    memory,
  })
}

switch (command) {
  case "chat": {
    const prompt = args.join(" ").trim()
    if (!prompt) {
      console.error('Usage: thincoder chat "<prompt>"')
      process.exit(1)
    }

    const agent = makeAgent()
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
        onPermissionRequest: askPermission,
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
    await memoryCommand(memory, args)
    break
  }

  case "tui":
  case undefined: {
    const agent = makeAgent()
    const { startTUI } = await import("../src/tui.mjs")
    try {
      await startTUI(agent)
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
