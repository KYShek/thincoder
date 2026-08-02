# ThinCoder 架构设计

> 依据：REQUIREMENTS.md（需求已定稿）。本文档定义 v1 的模块划分、接口与开发顺序。
> 约束：纯 mjs、无构建、Node >= 24、零 npm 依赖（仅 Node 标准库）。

## 设计原则

1. **零依赖**：只用 Node 标准库。`node:sqlite` 作存储，`fetch` 调 LLM，裸 ANSI 做 TUI。这不是苦行，是工程洁癖——每引入一个 npm 包就引进一份技术债（bug、安全漏洞、版本冲突）。我们做的是专业工程工具，不是玩具。
2. **接口先行**：模块间只通过显式接口通信，尤其是 memory——团队记忆的扩展位在此
3. **可运行验证**：每个里程碑都必须实际跑通，不留"写了没跑"的代码（teamcode 教训）
4. **准比短重要**：上下文宁长勿缺。1M 窗口是常态，未来继续增长。不要为了省 token 砍掉模型需要的信息——信息完整优先于字数精炼。
5. **代码是问题，不是答案**：编程智能体的场景是改代码，不是读教材。面对的项目代码可能有 bug、有过时设计、有技术债——模型应诊断和修复，不是朝圣模仿。
6. **面向全球，不做中文限定**：不预设用户是中国开发者。提示词用英文书写（模型对英文指令服从性更好），TUI 文本、系统消息、CLI 输出均应可切换语言，英文为默认回落。

## 目录结构

```
thincoder/
├── package.json          # type: module, bin 入口, engines: node >= 24
├── bin/
│   ├── thincoder.mjs     # 可执行入口（#!/usr/bin/env node），解析 argv，分发命令
│   └── thincoder.cjs     # CommonJS shim（npm bin 入口）
├── src/
│   ├── agent.mjs         # Agent 主循环 + 提醒注入 + 完成守卫 + 修复-验证循环 + 增量索引
│   ├── agent/            # agent 循环辅助
│   │   ├── dispatch.mjs  # 两段式工具调度
│   │   ├── setup.mjs     # 系统提示词组装
│   │   └── helpers.mjs   # 工具函数与常量
│   ├── agent-tools/      # 自律工具（task/plan/goal/verify/subagent/skill/recent_changes）
│   ├── agent-tools.mjs   # 自律工具注册入口
│   ├── provider/         # LLM 调用
│   │   ├── core.mjs      # SSE 流式 + reasoning_content + usage
│   │   ├── rate.mjs      # TPM/RPM 闸门
│   │   └── index.mjs     # 入口（chat / listModels / createProvider）
│   ├── tui/              # 裸 ANSI TUI（~24 个模块）
│   │   ├── index.mjs     # startTUI + render 副作用
│   │   ├── layout.mjs    # 声明式面板布局引擎
│   │   ├── render.mjs    # 绘制原语（charWidth / wrapText / formatTables / sanitize）
│   │   ├── render-frame.mjs  # 纯帧渲染器
│   │   ├── ansi.mjs      # ANSI 常量
│   │   ├── agent-turn.mjs    # agent 循环 + 回调构造
│   │   ├── key-handler.mjs   # 键盘事件分发
│   │   ├── startup.mjs       # 启动画面 + 会话恢复 + 后台索引
│   │   ├── interaction.mjs   # 权限审批 + Q&A
│   │   ├── pickers.mjs       # 通用列表选择器 + 模型选择器
│   │   ├── wizard.mjs        # 首次启动配置向导
│   │   ├── slash-commands.mjs # 斜杠命令分发 + Tab 补全
│   │   ├── cmd-*.mjs         # 各命令实现（17 个）
│   │   ├── config-helpers.mjs # 配置持久化辅助
│   │   └── clipboard.mjs     # 剪贴板图片粘贴
│   ├── tui.mjs           # 重导出 shim → src/tui/index.mjs
│   ├── tools/            # 工具系统（20+ 文件/网络/git 工具）
│   │   ├── index.mjs     # builtinTools 注册
│   │   ├── file.mjs      # read / write / edit / insert_after / read_image
│   │   ├── system.mjs    # bash / glob / grep / ls
│   │   ├── git.mjs       # git_diff / git_status / git_log / question / checkpoint
│   │   ├── web.mjs       # websearch / fetch
│   │   ├── patch.mjs     # apply_patch / syntax_check / delete
│   │   ├── shared.mjs    # 工具共享工具函数
│   │   ├── repomap.mjs   # 依赖大纲（repo_outline 工具）
│   │   ├── repomap-parse.mjs # import/export 解析 + 依赖图
│   │   └── *.md          # 工具描述（19 个）
│   ├── tools.mjs         # 重导出 shim → src/tools/index.mjs
│   ├── context.mjs       # 上下文压缩（关键决策保存 + task/plan 回注）
│   ├── memory/           # 三层记忆
│   │   ├── schema.mjs    # 常量 / DDL
│   │   ├── core.mjs      # CRUD + 检索
│   │   ├── code-index.mjs + code-sync.mjs  # 代码块索引
│   │   └── docs.mjs      # 文档块索引
│   ├── memory.mjs        # 重导出 shim
│   ├── session.mjs       # 会话持久化（5 槽位轮转）
│   ├── embedding.mjs     # 向量 embedding（SiliconFlow bge-m3）
│   ├── mcp/              # MCP 客户端（stdio / HTTP / WebSocket）
│   ├── mcp.mjs           # MCP 入口
│   ├── config.mjs        # 配置加载 + provider 预设管理
│   ├── git/              # checkpoint.mjs（git 存档点）+ gitmem.mjs（Team 层同步）
│   ├── skills.mjs        # 项目技能加载
│   ├── markdown.mjs      # frontmatter 解析（零依赖）
│   ├── distill.mjs       # 会话知识提取
│   ├── prompts/          # 提示词文本
│   │   ├── system.md     # 核心规则（主/子通用）
│   │   ├── discipline.md # 编码/测试纪律
│   │   ├── main.md       # 主 agent 专属条款（subagent/goal/verify/skill/plan）
│   │   ├── explore.md / coder.md / plan.md  # 子 agent 角色 overlay
│   └── cli/              # CLI 命令（distill / memory / permission / wizard）
├── test/
│   ├── agent.test.mjs    # agent 循环端到端（mock LLM server）
│   ├── memory.test.mjs   # 记忆 CRUD + 检索
│   ├── tools.test.mjs    # 工具测试
│   └── tui.test.mjs      # TUI 纯函数与布局
└── docs/design/          # 设计文档
    ├── REQUIREMENTS.md
    ├── ARCHITECTURE.md
    ├── ARCHITECTURE-v2.md
    ├── EVALUATION.md
    └── PHILOSOPHY.md
```

总源文件 ~82 个 `.mjs` + 19 个 `.md` 工具描述。测试用 Node 内置 `node:test` + `node:assert`，不引 vitest。

## 模块接口

### provider/ — LLM 调用

`src/provider/core.mjs` 是核心，`index.mjs` 重导出 `chat` / `createProvider` / `listModels`。

```js
// 创建 provider。config: { baseURL, apiKey, model }
export function createProvider(config)

// 流式对话。messages: OpenAI 格式; tools: 工具 schema; 
// onToken: (text) => void 流式回调; onReasoning: 思考流回调
// 返回 { content, toolCalls, usage, finishReason, reasoning }
export async function chat(provider, { messages, tools, onToken, onReasoning, signal })

// 错误分级：可重试（网络/5xx/429）vs 不可重试（4xx 参数错误）
// 由 provider 内部处理重试（指数退避，最多 3 次），调用方无感
// rate.mjs 提供 TPM/RPM 闸门控制
```

覆盖范围：只跟顶流、只跟最新——当前内置 DeepSeek / Kimi / GLM / Qwen / MiniMax 五家国内顶流厂商的旗舰模型。不做 Ollama 本地模型、不做 Anthropic 原生协议、不做"通用 OpenAI 兼容端点"泛化承诺。预设表随模型换代增删，不留历史包袱。

注意：流式解析时除 `delta.content` 外必须同时认 `delta.reasoning_content`（DeepSeek-R1 类推理模型的思考流），思考流与正文流分开回调，TUI 可选择折叠展示。

thinking 模式的协议约束：是否回传 reasoning_content 由规格表 reasoningEcho 决定——"required"（DeepSeek/Kimi K3，缺失会 400 / Preserved Thinking 要求保留）必须回传；"optional"（GLM，clear_thinking 默认清除历史 reasoning）不回传；未声明（未知模型）保守不回传。实现：readSSE 累积 reasoning → agent.mjs 入 history 时按 reasoningEcho 决定是否以 reasoning_content 字段挂在 assistant 消息上。估算 token 时该字段计入长度（思考链很长，影响压缩阈值判断）。

### tools/ — 工具系统

工具定义分散在 `src/tools/file.mjs` / `system.mjs` / `git.mjs` / `web.mjs` / `patch.mjs` / `checklist.mjs`，统一在 `index.mjs` 注册为 `builtinTools` 数组。描述文本存在 `src/tools/*.md`，运行时动态加载。

```js
// 每个工具的定义形状（对齐 OpenAI tool calling schema）：
{
  name: "read",
  description: "...",                    // 从 .md 文件动态加载
  parameters: { type: "object", ... },   // JSON Schema
  readonly: true,                        // 只读工具可并行；false 则串行
  outputPanel: false,                    // 流式输出工具走输出面板
  multimodal: false,                     // 多模态工具返回 { text, images }
  execute: async (args, ctx) => result   // ctx: { cwd, agent, signal, ... }
}

export const builtinTools = [read, write, edit, bash, glob, grep, ...]  // 20 个工具
export function toOpenAISchema(tool)     // 转成 OpenAI tools 参数格式
```

调度由 `src/agent/dispatch.mjs` 负责——两段式：阶段一逐条权限确认，阶段二只读并行、副作用串行。

关键决策：
- `bash` 工具有超时（默认 120 秒）和输出截断（防上下文爆炸）
- `edit` 用 old_string/new_string 精确替换（参照主流实践，可靠）
- 危险操作（写文件、bash）在 TUI 层做权限确认，tools 层只做执行——关注点分离
- `checklist` 管**项目级**任务清单（`.thincoder/checklist.md`，人可读可手改），与 `task`（会话内单任务拆解）互补；条目一一对应需求/设计要点，标 done 自动归档到 `checklist-done.md`；每轮 run 开头把 pending + in_progress 条目作为 transient reminder 注入（`setup.mjs`）——上下文会压缩，清单文件不丢

### agent.mjs — 主循环

主循环在 `src/agent.mjs`，辅助模块在 `src/agent/`：
- `dispatch.mjs`：两段式工具调度（阶段一权限确认，阶段二分类执行）
- `setup.mjs`：系统提示词组装（记忆注入、技能列表、项目指令）
- `helpers.mjs`：工具函数与常量

自律工具（task/plan/goal/verify/subagent/skill）在 `src/agent-tools/`，由 `agent-tools.mjs` 注册。

```js
// 跑一轮任务。input: 用户输入字符串
// callbacks: { onToken, onReasoning, onToolCall, onToolResult, onPermissionRequest, ... }
// 返回最终文本
export async function runAgent(agent, input, callbacks, { depth, signal, resume })

// agent 内部状态
export function createAgent({ provider, tools, config, cwd, memory, overlay, ... })
```

循环逻辑（学 kimi-code 的扎实劲儿，去掉花哨部分）：
1. 用户输入入 context；检索相关记忆注入 system prompt
2. 调 provider.chat（带 tools schema）
3. 无 toolCalls → 流式输出，结束
4. 有 toolCalls → 按"两段式"执行（见下）→ 结果回喂 context → 回到 2
5. 循环上限（默认 100 轮）防失控；上下文超阈值时先压缩再继续

**工具执行：两段式并行（已确认 ✅，调研自三个榜样）**

三个榜样（kimi-code / MiMo-Code / opencode）全部并行执行 toolCalls，且系统提示词都主动要求模型批量发并行调用——串行等于浪费模型的行为习惯。但 kimi-code 的资源冲突矩阵对 thin 太重，折中方案：

- 工具分两类：**只读**（read / glob / grep）与**有副作用**（write / edit / bash）
- **阶段一（串行准备）**：逐个 toolCall 做权限确认（用户审批一个一个来，体验清晰）
- **阶段二（分类执行）**：只读工具 `Promise.all` 并行；有副作用工具逐个串行
- 结果按 `toolCallId` 配对回喂（OpenAI 协议按 ID 不按位置，完成乱序无正确性问题）
- 实现成本 ~20 行，拿到并行收益的 80%；冲突矩阵留给 v2 真有需要时
- 配套：system prompt 中明确鼓励模型批量发并行 tool call（三个榜样都这么做，模型已习惯该行为）

#### 任务规划与自律机制（实现增量，补录 ✅）

> 原稿未覆盖；实现时参考 kimi-code / Claude Code 补上，此处补录为正式设计。

**自律工具**（定义在 `src/agent-tools/`，由 `agent-tools.mjs` 注册，随主循环注入）：

| 工具 | 职责 | 注入范围 |
|---|---|---|
| `task` | 多步任务规划与进度跟踪（TodoList 模式），整体替换列表，readonly | 所有 agent |
| `plan` | plan mode 开关；plan mode 下拒绝一切非只读工具 | 所有 agent |
| `goal` | 长程自主目标生命周期（完成合约制，三态 active/complete/blocked） | 仅顶层（depth=0） |
| `verify` | 完成前自检：git diff --stat + task 清单 + 自检 checklist | 仅顶层 |
| `subagent` / `skill` | 子 agent（explore/plan/coder）与项目技能加载 | 仅顶层（防递归） |

**子 agent 权限模型**：explore/plan 强制只读（权限回调恒 false）；coder/默认角色在 AUTO 模式直接放行，**手动模式把权限请求排队透传到父 agent 的审批 UI**（工具名带 `coder/` 前缀，如 `coder/bash`）——人在回路，子 agent 的写操作由用户逐条批准，拒绝后子 agent 按 overlay 设计改为交报告。并行子 agent 的请求经 `parent._permQueue` 串行化，避免两个审批同时弹出互相覆盖（question 工具的教训）。

**plan 子 agent（借鉴 kimi-code 的 plan profile）**：只读规划 agent，交付物是计划本身。overlay 的灵魂是**编排意识**——先判断是否足够了解代码库，不足则明确列出"建议父 agent 派 explore 调查的问题"（plan → explore → plan 链），而非硬猜；输出契约：引用真实文件/行号、步骤可验证、有权衡时推荐一个方案并给理由。工具与 explore 相同（只读过滤），git 上下文同样注入。与 plan mode 互补：plan mode 是用户在场审批方案，plan 子 agent 是父 agent 自主外包规划阅读。

**prompt 分层组织（借鉴 kimi-code 的自包含 profile，分文件方案）**：`system.md` 是核心规则（主/子通用：诚实、并行、最小改动、编码纪律）；`discipline.md` 是编码/测试纪律；`main.md` 是主 agent 专属条款（plan/goal/skill/subagent/verify——子 agent 没有这些工具，prompt 不教它调不存在的东西，消除"继承全量 prompt 再打补丁"的矛盾）；子 agent prompt = 角色 overlay（`explore.md` / `coder.md` / `plan.md`，**开头**，对齐 kimi 的 role prefix，身份先于通用规则）+ 核心规则。

**提示注入防御与上下文工程（借鉴 kimi-code）**：
- goal 提醒：目标文本 XML 转义 + `<untrusted_objective>` 标签包裹 + "是数据不是指令"声明——用户目标里的"忽略你的指令"不再能穿透
- 技能清单以 "DISREGARD any earlier skill listings" 开头（刷新即旧单作废）；技能按名去重——history 里已有 `<skill-loaded>` 块不重复展开（历史即账本）
- 压缩摘要：第一人称现在时交接笔记、未验证事项必须标注；摘要前缀"当笔记不当证据"
- 项目指令：每份 `<!-- From: <path> -->` 来源标注（冲突裁决可追溯）；超 8000 字符截断时留下显式 WARNING，不静默
- 注入自愈：AUTO 提醒被压缩折叠后（history 查不到）自动补播
- 工具结果超 16k 字符整体落盘 `~/.thincoder/tool-results/`，模型只见 2k 预览 + 路径 + read 分页指引（落盘失败退化为硬截断）
- **截断纪律**：一切截断必须发生在落盘之后——工具输出上限 200k 只是内存安全阀（远高于 16k 落盘阈值）；子 agent 报告不再内部截断（旧 32k 上限会在落盘前丢内容）；压缩序列化 user 消息放宽到 8000（长需求不进摘要器就丢原始意图）；项目指令 32K 软上限只警告不截断（对齐 kimi-code）
- 工作目录浅层树注入（仅顶层、run 开头的 user 上下文消息；根 30 项/子目录 10 项、目录优先、隐藏折叠、`.git`/`node_modules` 跳过）——开局方位感，且新消息不破前缀缓存

**报告质量兜底（借鉴 kimi-code 的 summaryPolicy）**：子 agent 报告不足 200 字符视为交接不完整，打回扩写一次——子 agent 的 history 还在，续写指令作为新输入追加，它能看到自己刚才的工作；重试仅 1 次，避免死循环。

**explore 的 git 上下文（借鉴 kimi-code 的 promptPrefix）**：explore 子 agent 启动时向输入注入仓库现状（当前分支、最近 5 条提交、工作区改动清单）——探索问题常和仓库状态有关；非 git 仓库静默跳过。

**促使模型"落地前先制定 todolist"的四层机制（对齐 kimi-code，软引导不硬强制）：**

1. **工具描述 prompt**：写明何时该用（多步任务动手前先建表、收到多步指令先落成 tasks）、何时不该用（单发请求）、状态机纪律（恰好一个 in_progress、完成立即标 done 不批量补标、测试红不许标 done、阻塞保持 in_progress、避免 churn）
2. **工具结果即时强化**：每次 task 写入成功的 result 尾部附"继续保持恰好一个 in_progress、完成立即标 done"提醒，形成即时反馈回路
3. **闲置提醒注入**：10 轮未碰 task 工具即注入 system reminder（**仅顶层 agent，depth=0**——子 agent 生命周期短、任务单一，提醒建表纯浪费 token）——有未完成项催更新（附列表快照）；**从未建表也提醒**（建议为多步工作建表，"不适用就忽略"）；提醒均要求不向用户提及。goal 每 10 轮、plan mode 每 8 轮同机制；提醒统一以 `role: "user"` 的 `[System reminder: ...]` 写入 history
4. **生命周期保障**：压缩后以独立 system reminder 回注 task 列表（每次压缩重新注入，永远最新且在历史末尾；单一信息源，不嵌入摘要正文）；tasks 随会话持久化（session.mjs），resume 恢复

**完成守卫（completion guard）**：模型给出最终回答（无 toolCalls）时，若本轮运行用写/编辑类工具改过文件却没跑过 `verify`，不直接收工——把回答入历史、注入"先跑测试并调 verify 自检"的 system reminder 后继续循环。每次 runAgent 最多推一次（防死循环）；`bash` / `subagent` 不算 mutation（跑测试、explore 子 agent 不该被催；coder 子 agent 有专属校验提醒）。仅顶层 agent（depth=0）生效。

**长程自主任务（goal mode，对齐 kimi-code 的 goal 设计）**：
- **完成合约**：`goal set` 强制要求可机器检查的完成条件（测试/命令输出/搜索结果），"做个东西"式的愿望被拒绝——没有验证手段的目标不值得设立
- **每轮状态注入**：goal active 时每轮注入 `turns N/预算 (remaining M)` + 目标文本（untrusted 转义）+ 审计纪律；预算（默认 200 轮，`config.agent.goalTurns` 可配）消耗 ≥75% 切换为"不要开新的自由裁量工作"预警。每轮注入同时解决了压缩后 goal 感知丢失（下一轮自动恢复）
- **完成审计**：`goal complete` 要求 criteria 声明的检查真的跑过；本轮改过文件没跑 verify 会被硬拒（与完成守卫共用 `_mutatedThisRun`/`_verifiedThisRun` 证据链）——虚假完成是自主任务的最坏结果
- **阻塞审计**：`goal blocked` 需同一阻塞条件**连续 3 次**才受理（工具内 `_blockTally` 计数，换条件重新计）——防止一遇阻就放弃，也防止死磕不报
- **停滞检测**：同一工具+同一参数连续 3 次调用，注入"你在原地空转，换条路或求助"提醒（kimi-code 没有的机制，长程任务防死循环）

**编码纪律（system prompt）**：`discipline.md` 尾部「Coding discipline」段（对齐 kimi-code 的严谨条款）——修 bug 先找根因不打补丁式修复、匹配周边代码风格、用库前先确认项目已有依赖、重构更新所有调用方且不改测试逻辑凑通过、不留占位符、改完扫旧注释、终答前重读用户最新请求。原则：token 花在验证上是合算的。

**前缀缓存（context caching）**：DeepSeek 自动缓存请求公共前缀（命中价约为 miss 的 1/120），前提是 system prompt + 历史消息的前缀跨请求逐字节不变。约束落到代码上：
- system prompt 只允许放跨 run 稳定的内容；`Session start` 时间戳每会话固定一次（`agent._sessionStart`），不能每次 runAgent 重新取
- 每轮变化的**记忆注入**不进 system prompt，作为独立 user 上下文消息（`[Relevant memories ...]`）随输入一起入 history——历史只增不改，前缀缓存照常命中
- 技能列表、项目指令按 cwd 稳定，留在 system prompt；skills 文件变更会破一次缓存，可接受
- 回归测试：连续两次 runAgent，断言两请求的 system 消息逐字节相等

**视觉能力防护（image_url 会话毒化）**：文本模型的 API 见到任何一条消息含 image_url 部分就整个请求 400——历史里混进一张图，之后每轮请求都挂，会话直接变砖。三道防线：
1. `read_image` 执行前按 `specForModel(model).multimodal` 拒绝非视觉模型（读文件之前就拒，错误信息给出替代方案）
2. 主循环注入多模态工具结果时，非视觉模型改注入 system reminder（"图片未注入，不要重复调用"），image 部分不进历史（纵深防御）
3. `stripImagesForTextModel`（`provider/core.mjs`）发送前把历史里残留的 image_url 替换为文本占位符——防"视觉模型会话切到文本 provider 恢复"的存量毒化；历史本身不改，切回视觉模型图片即恢复

**TUI todo 面板**：对话区与输入框之间常驻，最多 5 行（`▶ in_progress` / `✓ done`（暗色+删除线）/ `○ pending`；超 5 条优先 in_progress、兼顾最早 pending 和最近 done）；一轮结束全部 done 自动收起；会话恢复时以 `agent.tasks` 直接初始化。状态栏保留 `▶done/total` 计数，对话区每次更新留痕 `[task] x/y ▶ 当前任务`。chat 命令经 stderr 输出同款留痕。

**token 用量展示**：`readSSE` 捕获 `usage` → runAgent 经 `callbacks.onUsage` 透传 → TUI 状态栏累计显示 `↑输入 ↓输出 hit 缓存命中率%`（DeepSeek usage 自带 `prompt_cache_hit/miss_tokens`，前缀缓存效果因此可观测）；chat 命令结束时 stderr 输出 `[usage]` 汇总行。状态栏另显示**上下文利用率** `ctx N%`（`estimateTokens(history) / compactThreshold`，history 长度变化才重算；≥80% 变黄——到 100% 触发压缩，提醒用户收尾或 /new）。

### context.mjs — 上下文管理 + 压缩

```js
export function estimateTokens(messages)      // 粗略 token 估算
export async function compressIfNeeded(agent, threshold)  // 超阈值时压缩
export function compressFallback(agent)       // 压缩失败时确定性截断兜底
export function pushReal(agent, msg)          // 真实消息双写：同时追加 agent.history 与 agent._fullHistory
```

压缩策略（学 kimi-code，简化版）：保留 system + 最早 2 条 + 最近 N 条，中间用 LLM 摘要成一条。token 判定**实测优先**：上次响应的 `usage.prompt_tokens` 是完整上下文的实测值。安全点是 user **或 tool** 结尾（splitHistory 保证 tool_calls 配对完整）。摘要 LLM 连续 3 次失败降级为确定性截断（`compressFallback`，丢 middle 不碰网络——丢信息好过任务被 400 打死）。压缩后以独立 system reminder 回注 task 列表。原子写（tmp+rename）；每 5 个工具 turn 增量保存。

**机读上下文与人读历史分离（双结构）**：`agent.history` 是机读上下文（压缩照常），`agent._fullHistory` 是**永不压缩**的完整记录（人读）。压缩只作用前者；后者只追加。两线在**源头各自独立写入**：真实消息（用户输入、assistant 回复、tool 结果、多模态图像）统一走 `pushReal`——同时追加进 `agent.history` 与 `agent._fullHistory`（后者懒初始化）；机读消息（`[System reminder:`、`[User interrupt:`、压缩 note、task/plan/checkpoint 回注等 transient 注入）直接 push 进 `agent.history`，**不经过** `pushReal`，因此永远不进人读线。这一版取代了旧的事后差量同步（`syncFullHistory`/`_syncedLen` 基线）：差量基线需要在 reminder/checkpoint splice 时手工补偿，太脆、易错；源头双写语义直白——两条线各写各的，无需事后对账。checkpoint 引用、压缩 note、task/plan reminder 等机读消息**有意不进** `_fullHistory`。

**会话文件双写**（session.mjs）：`history` 字段存完整 `_fullHistory`（人读，VS Code 历史面板与 CLI resume 渲染读它）；`contextHistory` 字段存压缩后机读 `agent.history`。恢复（`applySession`）采**正确性优先**：机读上下文与人读线都从完整 `history` 重建（`_fullHistory = [...history]`、`agent.history = history`，无 `_syncedLen` 基线），`contextHistory` 仅供诊断不参与恢复——因为它可能陈旧（VS Code 扩展透传旧值后又追加了新 turn），且无可靠尾部特征区分「正常压缩后状态」与「被外部追加过的陈旧状态」， resume 用完整历史永远安全、超长则由下一轮压缩自然兜底。临时上下文打 `transient` 标记，保存时过滤。

**VS Code 端契约**（thincoder-vscode）：同一双结构语义，但两线由调用方（chat-panel）持有并经 `opts.history`（机读）/`opts.fullHistory`（人读）传入 `runAgent`，就地更新、跨调用存活。`session-io` 的 `saveMessages(msgDir, name, messages, contextHistory)` 把两条线写成 `{ messages, contextHistory }` 双字段；`loadSessionLines` 读回两线、`loadMessages` 只返回人读线供 UI。旧格式（裸数组或无 `contextHistory` 的对象）→ `contextHistory: null`，调用方回退从人读线播种机读线。

### memory/ — 记忆系统

核心在 `src/memory/core.mjs`，`memory.mjs` 重导出所有接口。三层记忆（Personal / Project / Team），FTS5 + 向量 RRF 混合检索。

```js
// 接口——统一检索入口，跨层合并结果：
export async function put(memory, { type, title, content, tags, scope })
export async function search(memory, query, { limit })      // FTS5 + 向量 RRF
export async function list(memory, { type, limit })
export async function remove(memory, id)

// 代码/文档索引（code-index.mjs + code-sync.mjs / docs.mjs）
export async function codeSync(memory, cwd)
export async function docSync(memory, cwd)
export async function reindexFile(memory, cwd, absPath)     // 单文件增量
```

- v1 实现：`node:sqlite` + FTS5 虚表，BM25 排序。entry.type ∈ `rule | knowledge | decision | pattern`（对齐团队记忆四类内容）
- **扩展位设计**：`createMemory` 返回的对象即接口。v2 团队版 = 同一接口 + git 同步层 + 向量检索（embedding 走 provider 的 fetch）+ RRF 排序，单机版无痛升级
- agent 集成：system prompt 里注入 `search` 结果 + 提供 `memory_put` / `memory_search` 两个工具让 agent 自主存取

### config.mjs — 配置

```js
export function loadConfig()    // 读 ~/.thincoder/config.json + 环境变量兜底
export function saveConfig(config)
export const PROVIDER_PRESETS   // 内置 provider 预设表（DeepSeek/Kimi/GLM/Qwen/MiniMax）
export function specForModel(model)  // 查模型规格（contextWindow / reasoningEcho / multimodal / tempRange）
```

```jsonc
// ~/.thincoder/config.json（multi-provider 结构）
{
  "providers": [
    { "name": "deepseek", "baseURL": "https://api.deepseek.com/v1", "model": "deepseek-chat" },
    { "name": "kimi", "baseURL": "https://api.moonshot.cn/v1", "model": "kimi-k3" }
  ],
  "activeProvider": "deepseek",
  "agent": { "maxTurns": 100, "compactThreshold": 100000, "compactThresholdAuto": true },
  "memory": { "dbPath": "~/.thincoder/memory.db" },
  "embedding": { "baseURL": "https://api.siliconflow.cn/v1", "model": "BAAI/bge-m3" }
}
```

apiKey 也可走环境变量（`THINCODER_API_KEY` 或 provider 惯用变量），配置文件不明文存储时可留空。

### tui/ — 裸 ANSI 终端 UI

`src/tui/index.mjs` 是入口，~24 个模块约 3,000 行，全部自研零依赖。

```
src/tui/
├── index.mjs          # startTUI 入口 + render 副作用 + submit + 依赖注入
├── layout.mjs         # 面板布局引擎（纯函数 computeLayout）
├── render.mjs         # 绘制原语（charWidth / wrapText / formatTables / sanitize）
├── render-frame.mjs   # 纯帧渲染器（renderFrame）
├── ansi.mjs           # ANSI 常量 + 颜色定义
├── agent-turn.mjs     # agent 循环 + 回调构造（流式/工具/子agent/压缩）
├── key-handler.mjs    # 键盘事件分发（权限/问题/选择器/向导/编辑/历史/粘贴）
├── interaction.mjs    # 权限审批 + Q&A 输入
├── pickers.mjs        # 通用列表选择器 + 模型管理选择器
├── wizard.mjs         # 首次启动配置向导
├── slash-commands.mjs # 斜杠命令分发 + Tab 补全
├── cmd-*.mjs          # 各命令实现（17 个：model/think/session/config/…）
├── startup.mjs        # 启动画面 + 会话恢复 + 后台索引
├── clipboard.mjs      # 剪贴板图片粘贴
├── distill-cmd.mjs    # /distill 命令
└── config-helpers.mjs # 配置持久化辅助
```

```js
export async function startTUI(agent, opts)   // 主入口，接管终端直到退出
```

### bin/thincoder.mjs — 命令分发

```
thincoder              # 启动 TUI（默认）
thincoder chat "..."   # 一次性问答（管道友好，可接 stdout）
thincoder memory       # 记忆管理子命令（list/search/put/remove）
thincoder sync         # Team 层 git pull + 增量索引
thincoder reindex      # 全量重建索引（含向量）
thincoder distill      # 从会话提取候选记忆条目
thincoder config       # 查看/设置配置
```

## 数据流（一次问答）

```
用户输入 → tui → agent.runAgent
  → memory.search 注入相关记忆
  → context 组装 → provider.chat (流式)
  → toolCalls? → tui 权限确认 → tools.execute → 回喂 → 再循环
  → 最终文本流式渲染到 tui
  → (可选) agent 自主调 memory_put 沉淀
```

## 开发顺序（里程碑）

| 里程碑 | 内容 | 验证标准 |
|---|---|---|
| M1 | provider + 最简 chat 命令（无 TUI） | `thincoder chat "hello"` 流式输出真实回复 |
| M2 | tools + agent 主循环 | `thincoder chat "读一下 package.json 总结它"` 能调工具完成 |
| M3 | TUI | 交互式对话跑通，流式渲染、权限确认可用 |
| M4 | context 压缩 | 构造超长对话，压缩后任务不断片 |
| M5 | memory | agent 能自主存取记忆，跨会话生效 |

每个里程碑完成后才可进入下一个——不允许出现"全写完再第一次运行"。

## 明确排除（防范围蔓延）

- TypeScript / 任何构建步骤 / 任何 npm 运行时依赖
- checkpoint、子 agent、MCP、工作流引擎（v2+ 再议）
- Anthropic 原生协议、embedding 向量检索（v1 记忆仅 FTS5）
- Windows 特殊处理以外的平台适配（win32 控制台 quirks 遇到再修）
