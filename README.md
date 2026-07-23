# ThinCoder

**Sharp Code, Zero Bloat.**

**一个"薄"的 AI 编程 agent：纯 `.mjs`、无构建、零 npm 依赖、Node.js 原生。**

ThinCoder 的 "Thin" 不是"功能单薄"，而是**思维锐利、直击要害**——像刀刃。
在 AI agent 都在卷"全能"的今天，ThinCoder 打的是反面那张牌：**克制、精准、不废话**。
它的人设是一个"话不多、一刀见血"的极客工程师：你给它复杂需求，它还你干净实现。

设计哲学（也是这个名字的全部含义）：只用 Node 标准库能实现的功能，就绝不引入依赖。整个项目的 `node_modules` 是空的。

## 特性

- **Agent 主循环**：LLM ↔ 工具调用循环，直到任务完成（上限 50 轮防失控）
- **工具集**：`read` / `write` / `edit` / `bash` / `glob` / `grep`，全部零依赖实现
- **两段式工具调度**：权限确认串行（一个一个问），只读工具并行执行，有副作用工具串行
- **流式 TUI**：裸 ANSI 实现（无 UI 库），对话流 / 流式输出 / 权限确认 / 翻页 / 输入历史
- **上下文压缩**：对话超阈值时自动摘要（保留最早 2 条 + 最近 10 条，中间 LLM 摘要）
- **长期记忆**：`node:sqlite` + FTS5 全文检索，中文按字索引（"分号"这种双字词也能命中），BM25 排序；agent 可自主存取，跨会话生效
- **LLM 调用**：原生 `fetch` 直连 OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / Ollama），流式 SSE，指数退避重试，支持 `reasoning_content` 思考流

## 要求

- Node.js >= 22（记忆功能用到 `node:sqlite`；推荐 24）
- 一个 OpenAI 兼容端点的 API key

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
```

API key 也可以走环境变量：`THINCODER_API_KEY`（或 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）。
`THINCODER_BASE_URL` / `THINCODER_MODEL` 可覆盖配置文件的对应项。

## 配置

`~/.thincoder/config.json`：

```jsonc
{
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",  // 任意 OpenAI 兼容端点
    "apiKey": "sk-...",                         // 或留空走环境变量
    "model": "deepseek-chat"
  },
  "agent": {
    "maxTurns": 50,                             // 工具循环上限
    "compactThreshold": 100000                  // 上下文压缩阈值（约 token 数）
  },
  "memory": {
    "dbPath": "~/.thincoder/memory.db"          // sqlite 记忆库路径
  }
}
```

## 架构

```
bin/thincoder.mjs   命令入口（tui / chat / memory）
src/
  provider.mjs      LLM 调用（fetch, SSE 流式, 重试）
  tools.mjs         6 个内置工具 + readonly 调度标记
  agent.mjs         主循环 + 两段式工具执行 + 记忆注入
  context.mjs       token 粗估 + 历史压缩
  memory.mjs        记忆接口（sqlite FTS5 实现；v2 团队记忆扩展位）
  config.mjs        配置加载
  tui.mjs           裸 ANSI 终端 UI（宽字符折行、滚动、权限确认）
test/               node:test 离线单测（npm test）
scripts/            真实 API 验证脚本
```

关键设计：

- **工具执行两段式**：阶段一串行做权限确认（有副作用工具逐个问用户）；阶段二只读工具 `Promise.all` 并行、有副作用工具串行。结果按 `toolCallId` 配对回喂
- **权限在 UI 层**：工具只负责执行，"问不问用户"是 TUI/CLI 的事，headless 场景不用改工具
- **记忆是接口**：v1 是 sqlite FTS5 单机实现；v2 团队版 = 同接口 + git 同步 + 向量检索，调用方无感
- **中文检索**：FTS5 unicode61 + 写入/查询两侧 CJK 逐字加空格，双字词可命中；语义匹配留给 v2 向量检索

## 开发

```bash
npm test                     # 离线单测（node:test）
node scripts/verify-compress.mjs   # 上下文压缩的真实 API 验证（需要有效配置）
```

代码约定：纯 `.mjs`，不加分号，禁止引入 npm 依赖（包括开发依赖）。

## 路线图

- **v2 团队记忆**：git 仓库作真相源（push/pull 即同步），本地 sqlite 索引（FTS5 + embedding 向量 + RRF 混合排序），手动分享 + 自动提取双轨沉淀
- v2 候选：checkpoint 断点恢复、子 agent 并行、MCP 接入

## License

MIT
