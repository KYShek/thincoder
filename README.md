# ThinCoder

**Sharp Code, Zero Bloat.**

**一个"薄"的 AI 编程 agent：纯** `.mjs`**、无构建、零 npm 依赖、Node.js 原生。**

ThinCoder 的 "Thin" 不是"功能单薄"，而是**思维锐利、直击要害**——像刀刃。
在 AI agent 都在卷"全能"的今天，ThinCoder 打的是反面那张牌：**克制、精准、不废话**。
它的人设是一个"话不多、一刀见血"的极客工程师：你给它复杂需求，它还你干净实现。

设计哲学（也是这个名字的全部含义）：只用 Node 标准库能实现的功能，就绝不引入依赖。整个项目的 `node_modules` 是空的。

## 特性

- **Agent 主循环**：LLM ↔ 工具调用循环，上限 100 轮防失控，完成守卫拦截未验证的改动
- **代码库理解** ⭐0.5.0：`repo_outline`（依赖大纲，启动自动注入）、`code_search`（源码 FTS5 + 向量 + JSDoc 提取）、`doc_search`（文档按 ## 标题分块检索）——后台索引、写文件自动增量更新、三工具按"结构→意图→细节"引导
- **模型适配** ⭐：只跟顶流、只跟最新。内置 DeepSeek / Kimi / GLM / Qwen / MiniMax 五家国内顶流厂商的旗舰模型，不做老旧模型兼容、不做本地模型适配。自动匹配上下文窗口、截断续写协议（prefix/partial）、思考模式 API（thinking.type / reasoning_effort）、输出上限。
- **工具集**：`read` / `write` / `edit` / `bash` / `glob`（支持 `**`） / `grep` / `websearch` / `ls` / `fetch` + `read_image`（图片/视频粘贴） + 三个检索工具 + MCP，全部零依赖，文件工具目录隔离
- **记忆系统**：三层（personal/project/team），FTS5 + 向量 RRF 混合检索，markdown 格式 git 友好
- **两段式工具调度**：权限确认串行，只读工具并行，副作用工具串行
- **会话持久化** ⭐0.5.0：最多 5 个归档槽位，`/session` 随时切换，恢复时工具结果可见
- **子 agent 并发**：`explore`/`plan`/`coder` 三种角色，并行派发，流式输出可见，报告进对话区
- **Plan Mode**：只读探索 + 方案设计，用户确认后实现
- **AUTO 模式**：`/auto` 完全授权，长任务免确认
- **任务跟踪**：`task` 工具拆解多步任务，状态栏 ✓n/m 实时进度，自动过滤已完成项
- **Goal/Verify/Skills**：长目标跟踪、完成验证、可复用技能
- **流式 TUI**：裸 ANSI，权限预览紧挨输入框，write/edit 自动展示 diff，多模态模型时输入框右上角显示粘贴快捷键提示（Win: Alt+V / Mac/Linux: Ctrl+V）

## 记忆系统：一人学到，全队皆知

三层记忆，全部"有就查、没有就跳过"，统一混合检索：

| 层               | 位置                                                | 同步方式                                                                          |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Personal**     | `~/.thincoder/memory.db`（sqlite）                  | 不同步，私有                                                                      |
| **Project**      | 项目仓库 `.thincoder/memory/*.md`                   | 随项目 git（ThinCoder **只写文件，绝不替你 commit**）                             |
| **Team**（可选） | 独立记忆仓库，clone 到 `~/.thincoder/teams/<name>/` | `thincoder sync`（pull --rebase）；写入时自动 commit + push（专用设施，可选启用） |

- **混合检索**：FTS5（BM25，中文逐字索引，双字词可命中）+ embedding 向量（暴力余弦）+ RRF(k=60) 融合排序
- **embedding**：OpenAI 兼容 `/v1/embeddings`，默认 SiliconFlow `BAAI/bge-m3`（免费额度，中文好）；Ollama 本地可作离线选项。向量惰性生成——写入不算，首次搜索时补算落库
- **条目格式**：Markdown + frontmatter（type/title/tags/author/created），GitHub 上直接可读可 review；每条目一个文件，天然规避合并冲突；真冲突时诚实报错，绝不自动合并
- **双轨沉淀**：规范靠手动写（`memory_put`），经验靠 `/distill` 从会话提取——**LLM 出候选、逐条人工 y/n 确认**才入库，绝不做全自动沉淀
- **检索隔离**：Project 层按项目路径隔离，A 项目的记忆不会漏进 B 项目

## 要求

- Node.js >= 24
- 一个 OpenAI 兼容端点的 API key
- 可选：embedding 服务的 key（不配置则退化为纯 FTS 检索）

## 快速开始

```bash
# 安装
npm install -g thincoder

# 启动 TUI（默认命令）
thincoder
```

首次启动会自动进入初始配置向导：方向键选提供商（内置预设或自定义端点）→ 输入 API key → 可选填 embedding key（SiliconFlow，开启记忆向量检索，可跳过）→ 方向键选模型，全程不用手编配置文件。之后随时可用 `/provider`、`/model`、`/config embedkey` 调整。`chat`/`distill` 在终端下没配 key 时也会就地问答式配置（管道/CI 环境则报错退出并提示）。

也可以直接手写配置 `~/.thincoder/config.json`（见下文"配置"），然后：

```bash
# 一次性问答（管道友好）
thincoder chat "读一下 package.json 并总结"

# 记忆管理
thincoder memory put --type=rule --title="代码规范" --content="不加分号"
thincoder memory search "代码规范"
thincoder memory list
thincoder memory remove 1

# 团队记忆（可选，配置 memory.team 后可用）
thincoder sync                       # 拉取团队仓库并重建索引

# 从会话记录提取知识（逐条确认后入库）
thincoder distill session.txt

# 升级
thincoder upgrade
```

从源码运行：把上面的 `thincoder` 换成 `node bin/thincoder.mjs`。

TUI 内斜杠命令：`/help`、`/model`（方向键选择全部 provider 的全部模型；`/model <名称>` 直接切换）、`/provider`（增/删 provider、配 key，支持自定义端点）、`/think`（思维模式开关与推理强度）、`/config`（查看配置、`/config embedkey` 配 embedding key、`/config set` 改参数）、`/session`（列出/切换归档会话）、`/reindex`（重建索引）、`/distill`（从当前会话提取知识）、`/clear`、`/exit`。输入 `/` 时状态栏实时提示匹配命令。

环境变量：`THINCODER_API_KEY`（或 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）、`THINCODER_BASE_URL`、`THINCODER_MODEL`、`SILICONFLOW_API_KEY`。

## 配置

`~/.thincoder/config.json`：

```jsonc
{
  "providers": [
    // 可配多个，/model <名称> 切换
    {
      "name": "deepseek",
      "baseURL": "https://api.deepseek.com/v1", // 任意 OpenAI 兼容端点
      "apiKey": "sk-...", // 或留空走环境变量
      "model": "deepseek-chat",
      // 可选：主动节流预算（按账户限速等级自配，不配则关闭闸门，429 退避仍生效）。
      // 限速是账户级独立计数器（RPM/TPM 按 60s 窗口），等级查各厂商控制台
      // "tpm": 200000, // tokens/分钟（输入+输出总量）
      // "rpm": 50,     // 请求数/分钟
    },
  ],
  "activeProvider": "deepseek", // 当前激活的 provider 名
  "embedding": {
    // 可选：不配则纯 FTS 检索
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-...", // 或 SILICONFLOW_API_KEY
    "model": "BAAI/bge-m3",
  },
  "agent": {
    "maxTurns": 100, // 工具循环上限
    "compactThreshold": 100000, // 上下文压缩阈值（约 token 数）
  },
  "memory": {
    "dbPath": "~/.thincoder/memory.db", // sqlite 索引库路径
    "projectDir": ".thincoder/memory", // Project 层目录（相对项目根）
    "team": {
      // 可选：不配则 Team 层禁用
      "name": "myteam",
      "repo": "git@github.com:org/team-memory.git",
    },
  },
  "mcp": {
    // 可选：MCP server 列表
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      },
    ],
  },
}
```

## 架构

```
bin/thincoder.mjs   命令入口（tui / chat / memory / sync / distill）
src/
  provider.mjs      LLM 调用（fetch, SSE 流式, 重试）
  embedding.mjs     向量嵌入（OpenAI 兼容 /v1/embeddings）
  tools.mjs         16 个内置工具 + MCP 包装 + readonly 调度标记
  mcp.mjs           MCP 客户端（JSON-RPC + stdio transport，零依赖）
  agent.mjs         主循环 + 两段式工具执行 + plan/task/goal/skill/subagent/verify 工具
                    + 增量索引（write/edit/delete 后自动 reindexFile）
  repomap.mjs       仓库依赖大纲（import/export regex 解析，工具按需调用）
  context.mjs       token 粗估 + 历史压缩 + task 回注
  memory.mjs        记忆核心：三层合并检索 + 代码/文档索引（code_chunks/doc_chunks）
                    + FTS5 + 向量 RRF + JSDoc 提取 + 单文件增量索引
  session.mjs       会话持久化（最多 5 个归档槽位，按项目 cwd 隔离）
  skills.mjs        技能发现/加载（.thincoder/skills/*.md）
  markdown.mjs      条目格式（frontmatter 解析/序列化）
  gitmem.mjs        Team 层 git 同步（clone/pull --rebase/push，系统 git）
  distill.mjs       会话知识提取（候选 + 人工确认）
  checkpoint.mjs    git patch 快照 / 回滚
  config.mjs        配置加载
  tui.mjs           裸 ANSI 终端 UI（宽字符折行、滚动、权限确认、斜杠命令）
test/               node:test 离线单测（npm test）
scripts/            真实环境验证脚本（压缩、团队同步）
```

关键设计：

- **工具执行两段式**：阶段一串行做权限确认（有副作用工具逐个问用户）；阶段二只读工具 `Promise.all` 并行、有副作用工具串行。结果按 `toolCallId` 配对回喂
- **权限在 UI 层**：工具只负责执行，"问不问用户"是 TUI/CLI 的事，headless 场景不用改工具
- **索引是易失品**：sqlite 只是代码/文档/记忆的本地索引，`reindex` 随时可重建
- **代码/文档分离索引**：源码和 markdown 文档分表索引，LLM 通过不同工具检索——避免模型把旧代码模式当做设计规范
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

- MCP HTTP transport（当前仅 stdio）
- 更多内置 skills

## 更新日志

### 0.7.4（2026-07）
- **verify 分层自检**：默认 quick 模式（语法检查变更文件 + git diff + 自检清单，毫秒级），`full=true` 才跑全量 npm test——不再每改一行都等十几秒全量；quick 即满足完成守卫，收尾/改核心设施时再用 full
- **提示词纪律强化**：SYSTEM_PROMPT 新增测试纪律（何时跑哪层验证）与调试策略（先诊断再治、一次只改一处）；coder/plan/main overlay 补自检清单（最简方案、匹配项目模式、不碰无关文件）
- **修复**：quick 模式下语法检查失败被误标为验证通过，完成守卫被架空

### 0.7.3（2026-07）
- **图片粘贴**：新增 `read_image` 工具，支持从剪贴板粘贴图片/视频，多模态模型可直接理解截图、UI 设计稿、架构图（Win: `Alt+V` / Mac/Linux: `Ctrl+V`）
- **TUI 粘贴提示**：使用多模态模型时，输入框右上角自动显示操作系统对应的粘贴快捷键，纯文本模型不显示

### 0.7.2（2026-07）
- **TPM/RPM 主动节流闸门**：provider 配置 `tpm`/`rpm` 预算后，发请求前本地滑动窗口记账（60s，输入+输出），超预算先睡到窗口腾出空间而不是打 429 碰运气；主循环/压缩摘要/子 agent/截断续写全覆盖。等待时状态栏显示 `TPM 节流等待 ~Ns`，不配的 provider 闸门关闭
- **429 专项退避**：尊重 `Retry-After` 响应头，无则按 15s/30s/60s（60s 窗口，秒级退避无意义）；配额/余额错误（`exceeded_current_quota_error`）与限速区分，不再无效重试
- **依赖注入改为紧凑摘要**：`buildSummary`（目录级依赖 + 枢纽文件 + 入口，天然 ~1-2k 字符）替代全量大纲注入，详细 import/export 用 `repo_outline` 按需查
- **TUI 菜单化**：`/model` `/config` `/provider` `/think` `/mcp` `/goal` `/session` `/rewind` 统一改为选择器菜单
- **会话健壮性**：归档/切换时文件损坏或磁盘异常不再崩，静默放弃

### 0.7.1（2026-07）
- **修复上下文爆炸（紧急）**：依赖大纲开局注入不再无界——多仓库父目录（索引数千文件）的全量大纲实测达 140 万字符 ≈ 35 万 token，且每轮对话重复注入累积，几轮即打爆上下文并触发 TPM 限流。现截断到 6000 字符（超出指引用 `repo_outline` 聚焦查询）且每会话只注一次
- **压缩逃逸口**：历史太短（≤13 条）切不出中间段时压缩永远不发生，一条巨型消息（大段粘贴/超大注入）即可卡死。现走确定性瘦身：超长 user/tool 正文截断换桩，不动 reasoning_content 与 tool_calls 配对
- **修复 docSync ReferenceError**：`failed`/`errors` 未声明导致文档索引同步每次调用必抛错（两个测试挂红）
- **apply_patch 工具**：统一 diff 多文件原子打补丁（任一 hunk 不上整体不写盘），权限预览直接展示 diff
- **checkpoint 工具**：`list`/`create`/`rewind` 快照能力暴露给模型（此前只接 TUI 自动快照 + /rewind，模型无法自救）；bash 销毁性 git 护栏升级为分段检测（`&&`/`;`/`|`/命令替换链式写法不再绕过）
- **bash 进程树杀**：超时/中断整树杀（POSIX 进程组 / Windows taskkill /T），不再残留孙进程
- **子 agent 显示契约**：只 relay 正文/思考 token 到 TUI 滚动区，内部工具调用不再刷屏
- **路径安全**：`resolveInCwd` 防 symlink 逃逸（realpath 二次校验）；edit 拒绝空 old_string；单文件增量索引跳过隐藏目录与 node_modules
- **其他**：SQLite WAL + busy_timeout、schema 迁移单事务、升级语义化版本比较、MCP cmd.exe 引号翻倍转义、gitmem 无变更不提交

### 0.7.0（2026-07）
- **模型协议深度适配**：reasoning_content 回传按模型区分（`reasoningEcho` 规格表字段）——DeepSeek/Kimi 必须回传，GLM 不回传；reasoning_effort 枚举校验（`reasoningEffortEnum`）；temperature 范围裁剪（`tempRange`）
- **Qwen/MiniMax 规格补齐**：reasoning_effort 枚举（Qwen 3.8-max-preview）、temperature 范围（Qwen [0,2)、MiniMax [0,2]）、MiniMax M3 thinking 模式
- **grep 上下文行**：`before`/`after` 参数（对应 grep -B/-A），匹配行用 `:`、上下文行用 `-`，同文件相邻区间去重合并
- **系统提示词边界规则**：不修改工作目录外文件，不许用 bash 绕过 read/write/edit 的目录限制
- **question 工具输入框标题**：固定为 ` Question `，提问文本走对话区（不再塞进输入框标题）

### 0.5.0（2026-07）
- **代码库理解**：`repo_outline`（依赖大纲，启动自动注入）、`code_search`（FTS5 + 向量 + JSDoc）、`doc_search`（按 ## 标题分块），写文件自动增量索引
- **模型适配**：5 家内置预设（DeepSeek/Kimi/GLM/Qwen/MiniMax），maxTokens 拉满、截断续写、思考模式 API 自动匹配
- 会话 5 槽位归档、`/session` 切换、恢复时展示工具结果
- 子 agent 流式输出可见、最终报告进对话区
- 文件工具目录隔离、权限预览紧挨输入框
- write/edit 自动附 git diff、edit 错误信息增强提示
- task 自动过滤已完成项、全部 done 时主动提醒
- 提示词引导"查官方文档 → 不一致就存项目记忆"

### 0.4.0
- 权限审批展示文件内容预览（write 内容、edit diff、bash 命令）
- todo 面板进度可视、状态栏 token 用量与上下文利用率
- 项目指令双层合并（全局 + 项目 AGENTS.md）

### 0.3.0
- MCP 客户端（JSON-RPC + stdio，零依赖）
- Skills 系统（`.thincoder/skills/*.md`）
- Plan/Goal/Question 工具
- 提示词外部化到 `.md` 文件、子 agent 角色 overlay
- task 严格纪律（keep ONE in_progress）、完成守卫（改文件未 verify 拦截）
- DeepSeek thinking 回传、system prompt 前缀缓存
- checkpoint 存档点 + `/rewind` 回滚

### 0.2.0
- multi-provider 配置（支持多端点切换）
- 初始配置向导（方向键选模型、配 key）
- `/think` 思维模式开关与推理强度
- `/model` 模型选择器
- bash 流式输出实时透传

### 0.1.0
- Agent 主循环、14 个内置工具、零依赖 TUI
- 三层记忆（personal/project/team）、FTS5 检索
- 会话持久化、上下文压缩、流式 SSE

## License

MIT
