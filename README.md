# ThinCoder

**Sharp Code, Zero Bloat.**

**一个"薄"的 AI 编程 agent：纯 `.mjs`、无构建、零 npm 依赖、Node.js 原生。**

ThinCoder 的 "Thin" 不是"功能单薄"，而是**思维锐利、直击要害**——像刀刃。
在 AI agent 都在卷"全能"的今天，ThinCoder 打的是反面那张牌：**克制、精准、不废话**。
它的人设是一个"话不多、一刀见血"的极客工程师：你给它复杂需求，它还你干净实现。

设计哲学（也是这个名字的全部含义）：只用 Node 标准库能实现的功能，就绝不引入依赖。整个项目的 `node_modules` 是空的。

## 特性

- **Agent 主循环**：LLM ↔ 工具调用循环，直到任务完成（上限 50 轮防失控）
- **工具集**：`read` / `write` / `edit` / `bash` / `glob` / `grep` / `websearch` / `ls` / `fetch`，全部零依赖实现
- **两段式工具调度**：权限确认串行（一个一个问），只读工具并行执行，有副作用工具串行
- **任务跟踪**：`task` 工具让 agent 拆解多步任务并跟踪进度（pending/in_progress/done），TUI 状态栏实时显示 ▶n/m
- **流式 TUI**：裸 ANSI 实现（无 UI 库），对话流 / 流式输出 / 权限确认 / 翻页 / 输入历史 / 斜杠命令
- **上下文压缩**：对话超阈值时自动摘要（保留最早 2 条 + 最近 10 条，中间 LLM 摘要）
- **三层记忆 + 团队共享**（见下）
- **LLM 调用**：原生 `fetch` 直连 OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / Ollama），流式 SSE，指数退避重试，支持 `reasoning_content` 思考流

## 记忆系统：一人学到，全队皆知

三层记忆，全部"有就查、没有就跳过"，统一混合检索：

| 层 | 位置 | 同步方式 |
|---|---|---|
| **Personal** | `~/.thincoder/memory.db`（sqlite） | 不同步，私有 |
| **Project** | 项目仓库 `.thincoder/memory/*.md` | 随项目 git（ThinCoder **只写文件，绝不替你 commit**） |
| **Team**（可选） | 独立记忆仓库，clone 到 `~/.thincoder/teams/<name>/` | `thincoder sync`（pull --rebase）；写入时自动 commit + push（专用设施，可选启用） |

- **混合检索**：FTS5（BM25，中文逐字索引，双字词可命中）+ embedding 向量（暴力余弦）+ RRF(k=60) 融合排序
- **embedding**：OpenAI 兼容 `/v1/embeddings`，默认 SiliconFlow `BAAI/bge-m3`（免费额度，中文好）；Ollama 本地可作离线选项。向量惰性生成——写入不算，首次搜索时补算落库
- **条目格式**：Markdown + frontmatter（type/title/tags/author/created），GitHub 上直接可读可 review；每条目一个文件，天然规避合并冲突；真冲突时诚实报错，绝不自动合并
- **双轨沉淀**：规范靠手动写（`memory_put`），经验靠 `/distill` 从会话提取——**LLM 出候选、逐条人工 y/n 确认**才入库，绝不做全自动沉淀
- **检索隔离**：Project 层按项目路径隔离，A 项目的记忆不会漏进 B 项目

## 要求

- Node.js >= 22（记忆功能用到 `node:sqlite`；推荐 24）
- 一个 OpenAI 兼容端点的 API key
- 可选：embedding 服务的 key（不配置则退化为纯 FTS 检索）

## 快速开始

```bash
# 配置（首次）
mkdir -p ~/.thincoder
cat > ~/.thincoder/config.json <<'EOF'
{
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",
    "model": "deepseek-chat"
  }
}
EOF

# 启动 TUI（默认命令）
node bin/thincoder.mjs

# 一次性问答（管道友好）
node bin/thincoder.mjs chat "读一下 package.json 并总结"

# 记忆管理
node bin/thincoder.mjs memory put --type=rule --title="代码规范" --content="不加分号"
node bin/thincoder.mjs memory search "代码规范"
node bin/thincoder.mjs memory list
node bin/thincoder.mjs memory remove 1

# 团队记忆（可选，配置 memory.team 后可用）
node bin/thincoder.mjs sync                       # 拉取团队仓库并重建索引

# 从会话记录提取知识（逐条确认后入库）
node bin/thincoder.mjs distill session.txt
```

TUI 内斜杠命令：`/help`、`/model`（查看/切换模型）、`/config`（查看配置）、`/distill`（从当前会话提取知识）、`/clear`、`/exit`。输入 `/` 时状态栏实时提示匹配命令。

环境变量：`THINCODER_API_KEY`（或 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）、`THINCODER_BASE_URL`、`THINCODER_MODEL`、`SILICONFLOW_API_KEY`。

## 配置

`~/.thincoder/config.json`：

```jsonc
{
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",  // 任意 OpenAI 兼容端点
    "apiKey": "sk-...",                         // 或留空走环境变量
    "model": "deepseek-chat"
  },
  "embedding": {                                // 可选：不配则纯 FTS 检索
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-...",                         // 或 SILICONFLOW_API_KEY
    "model": "BAAI/bge-m3"
  },
  "agent": {
    "maxTurns": 50,                             // 工具循环上限
    "compactThreshold": 100000                  // 上下文压缩阈值（约 token 数）
  },
  "memory": {
    "dbPath": "~/.thincoder/memory.db",         // sqlite 索引库路径
    "projectDir": ".thincoder/memory",          // Project 层目录（相对项目根）
    "team": {                                   // 可选：不配则 Team 层禁用
      "name": "myteam",
      "repo": "git@github.com:org/team-memory.git"
    }
  }
}
```

## 架构

```
bin/thincoder.mjs   命令入口（tui / chat / memory / sync / distill）
src/
  provider.mjs      LLM 调用（fetch, SSE 流式, 重试）
  embedding.mjs     向量嵌入（OpenAI 兼容 /v1/embeddings）
  tools.mjs         9 个内置工具 + readonly 调度标记
  agent.mjs         主循环 + 两段式工具执行 + 记忆注入
  context.mjs       token 粗估 + 历史压缩
  memory.mjs        记忆核心：三层合并检索（FTS5 + 向量 + RRF）
  markdown.mjs      条目格式（frontmatter 解析/序列化）
  gitmem.mjs        Team 层 git 同步（clone/pull --rebase/push，系统 git）
  distill.mjs       会话知识提取（候选 + 人工确认）
  config.mjs        配置加载
  tui.mjs           裸 ANSI 终端 UI（宽字符折行、滚动、权限确认、斜杠命令）
test/               node:test 离线单测（npm test）
scripts/            真实环境验证脚本（压缩、团队同步）
```

关键设计：

- **工具执行两段式**：阶段一串行做权限确认（有副作用工具逐个问用户）；阶段二只读工具 `Promise.all` 并行、有副作用工具串行。结果按 `toolCallId` 配对回喂
- **权限在 UI 层**：工具只负责执行，"问不问用户"是 TUI/CLI 的事，headless 场景不用改工具
- **索引是易失品**：sqlite 只是 markdown 真相源的本地索引，`reindex` 随时可重建；git 仓库才是团队记忆的真相源
- **git 边界**：Project 层只写文件不碰用户的仓库；Team 层是 ThinCoder 自管仓库才可自动 commit+push
- **中文检索**：FTS5 unicode61 + 写入/查询两侧 CJK 逐字加空格；语义匹配走向量通道

## 开发

```bash
npm test                          # 离线单测（node:test，含本地 mock 服务）
node scripts/verify-compress.mjs  # 上下文压缩的真实 API 验证（需要有效配置）
node scripts/verify-team.mjs      # 团队记忆 A->git->B 全链路验证（本地 git，离线）
```

代码约定：纯 `.mjs`，不加分号，禁止引入 npm 依赖（包括开发依赖）。

## 路线图

- v3 候选：checkpoint 断点恢复、子 agent 并行、MCP 接入

## License

MIT
