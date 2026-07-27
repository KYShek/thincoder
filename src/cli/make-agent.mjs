import { execSync } from "node:child_process"
import { join } from "node:path"
import { createAgent } from "../agent.mjs"
import { loadConfig, configDir } from "../config.mjs"
import { createMemory, memoryTools, syncDir, codeSearchTool, docSearchTool } from "../memory.mjs"
import { repoOutlineTool } from "../tools/repomap.mjs"
import { builtinTools } from "../tools/index.mjs"

/** 组装一个带记忆的 agent（同步各层索引后返回） */
export async function makeAgent() {
  const config = loadConfig()
  const provider = config.provider
  const providers = config.providersList
  const memory = createMemory({ dbPath: config.memory.dbPath })
  // 向量检索：配了 embedding 就启用（惰性生成向量，首次搜索时补算）
  if (config.embedding?.apiKey) {
    const { createEmbedder } = await import("../embedding.mjs")
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
    const { ensureClone } = await import("../git/gitmem.mjs")
    await ensureClone(team)
    await syncDir(memory, { layer: "team", dir: team.dir })
  }
  const baseTools = [...builtinTools, ...memoryTools(memory, { cwd, projectDir: config.memory.projectDir, author: gitAuthor(), team }), codeSearchTool(memory), docSearchTool(memory), repoOutlineTool(memory.db, cwd)]

  // MCP servers：并行连接（一个死 server 不会拖住启动），失败的收集警告（TUI 下 stderr 不可见，通过 agent 对象传递）
  const mcpServers = config.mcp?.servers ?? []
  let mcpTools = []
  const mcpWarnings = []
  if (mcpServers.length) {
    const { connectMcpServer } = await import("../mcp.mjs")
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
export function teamConfig(config) {
  const team = config.memory?.team
  if (!team?.repo) return null
  const name = team.name ?? "default"
  return { name, repo: team.repo, dir: team.dir ?? join(configDir, "teams", name) }
}

/** 条目作者：git config user.name 兜底 unknown */
export function gitAuthor() {
  try {
    return execSync("git config user.name", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"
  } catch {
    return "unknown"
  }
}
