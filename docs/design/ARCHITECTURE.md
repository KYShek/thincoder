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

### provider.mjs — LLM 调用

```js
// 创建 provider。config: { baseURL, apiKey, model }
export function createProvider(config)

// 流式对话。messages: OpenAI 格式; tools: 工具 schema; 
// onToken: (text) => void 流式回调
// 返回 { content, toolCalls, usage, finishReason }
export async function chat(provider, { messages, tools, onToken, signal })

// 错误分级：可重试（网络/5xx/429）vs 不可重试（4xx 参数错误）
// 由 provider 内部处理重试（指数退避，最多 3 次），调用方无感
```

覆盖范围：只跟顶流、只跟最新——当前内置 DeepSeek / Kimi / GLM / Qwen / MiniMax 五家国内顶流厂商的旗舰模型。不做 Ollama 本地模型、不做 Anthropic 原生协议、不做"通用 OpenAI 兼容端点"泛化承诺。预设表随模型换代增删，不留历史包袱。

注意：流式解析时除 `delta.content` 外必须同时认 `delta.reasoning_content`（DeepSeek-R1 类推理模型的思考流），思考流与正文流分开回调，TUI 可选择折叠展示。

thinking 模式的协议约束：是否回传 reasoning_content 由规格表 reasoningEcho 决定——"required"（DeepSeek/Kimi K3，缺失会 400 / Preserved Thinking 要求保留）必须回传；"optional"（GLM，clear_thinking 默认清除历史 reasoning）不回传；未声明（未知模型）保守不回传。实现：readSSE 累积 reasoning → agent.mjs 入 history 时按 reasoningEcho 决定是否以 reasoning_content 字段挂在 assistant 消息上。估算 token 时该字段计入长度（思考链很长，影响压缩阈值判断）。

### tools.mjs — 工具系统

```js
// 每个工具的定义形状（对齐 OpenAI tool calling schema）：
{
  name: "read",
  description: "...",                    // 给 LLM 看的
  parameters: { type: "object", ... },   // JSON Schema
  readonly: true,                        // 只读工具可并行；false（write/edit/bash）则串行
  execute: async (args, ctx) => result   // ctx: { cwd, signal }
}

export const builtinTools = [read, write, edit, bash, glob, grep]
export function toOpenAISchema(tool)     // 转成 OpenAI tools 参数格式
```

关键决策：
- `bash` 工具有超时（默认 120 秒）和输出截断（防上下文爆炸）
- `edit` 用 old_string/new_string 精确替换（参照主流实践，可靠）
- 危险操作（写文件、bash）在 TUI 层做权限确认，tools 层只做执行——关注点分离

### agent.mjs — 主循环

```js
// 跑一轮任务。input: 用户输入字符串
// callbacks: { onToken, onToolCall, onToolResult, onPermissionRequest }
// 返回最终文本
export async function runAgent(agent, input, callbacks)

// agent 内部状态：provider + tools + context + memory + config
export function createAgent({ provider, tools, context, memory, config })
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

**自律工具**（定义在 agent.mjs，随主循环注入，不走 tools.mjs）：

| 工具 | 职责 | 注入范围 |
|---|---|---|
| `task` | 多步任务规划与进度跟踪（TodoList 模式），整体替换列表，readonly | 所有 agent |
| `plan` | plan mode 开关；plan mode 下拒绝一切非只读工具 | 所有 agent |
| `goal` | 长程自主目标生命周期（完成合约制，三态 active/complete/blocked） | 仅顶层（depth=0） |
| `verify` | 完成前自检：git diff --stat + task 清单 + 自检 checklist | 仅顶层 |
| `subagent` / `skill` | 子 agent（explore/plan/coder）与项目技能加载 | 仅顶层（防递归） |

**子 agent 权限模型**：explore/plan 强制只读（权限回调恒 false）；coder/默认角色在 AUTO 模式直接放行，**手动模式把权限请求排队透传到父 agent 的审批 UI**（工具名带 `coder/` 前缀，如 `coder/bash`）——人在回路，子 agent 的写操作由用户逐条批准，拒绝后子 agent 按 overlay 设计改为交报告。并行子 agent 的请求经 `parent._permQueue` 串行化，避免两个审批同时弹出互相覆盖（question 工具的教训）。

**plan 子 agent（借鉴 kimi-code 的 plan profile）**：只读规划 agent，交付物是计划本身。overlay 的灵魂是**编排意识**——先判断是否足够了解代码库，不足则明确列出"建议父 agent 派 explore 调查的问题"（plan → explore → plan 链），而非硬猜；输出契约：引用真实文件/行号、步骤可验证、有权衡时推荐一个方案并给理由。工具与 explore 相同（只读过滤），git 上下文同样注入。与 plan mode 互补：plan mode 是用户在场审批方案，plan 子 agent 是父 agent 自主外包规划阅读。

**prompt 分层组织（借鉴 kimi-code 的自包含 profile，分文件方案）**：`SYSTEM_PROMPT.md` 是核心规则（主/子通用：诚实、并行、最小改动、编码纪律）；`main-overlay.md` 是主 agent 专属条款（plan/goal/skill/subagent/verify——子 agent 没有这些工具，prompt 不教它调不存在的东西，消除"继承全量 prompt 再打补丁"的矛盾）；子 agent prompt = 角色 overlay（**开头**，对齐 kimi 的 role prefix，身份先于通用规则）+ 核心规则。

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

**编码纪律（system prompt）**：`SYSTEM_PROMPT.md` 尾部「Coding discipline」段（对齐 kimi-code 的严谨条款）——修 bug 先找根因不打补丁式修复、匹配周边代码风格、用库前先确认项目已有依赖、重构更新所有调用方且不改测试逻辑凑通过、不留占位符、改完扫旧注释、终答前重读用户最新请求。原则：token 花在验证上是合算的。

**前缀缓存（context caching）**：DeepSeek 自动缓存请求公共前缀（命中价约为 miss 的 1/120），前提是 system prompt + 历史消息的前缀跨请求逐字节不变。约束落到代码上：
- system prompt 只允许放跨 run 稳定的内容；`Session start` 时间戳每会话固定一次（`agent._sessionStart`），不能每次 runAgent 重新取
- 每轮变化的**记忆注入**不进 system prompt，作为独立 user 上下文消息（`[Relevant memories ...]`）随输入一起入 history——历史只增不改，前缀缓存照常命中
- 技能列表、项目指令按 cwd 稳定，留在 system prompt；skills 文件变更会破一次缓存，可接受
- 回归测试：连续两次 runAgent，断言两请求的 system 消息逐字节相等

**TUI todo 面板**：对话区与输入框之间常驻，最多 5 行（`▶ in_progress` / `✓ done`（暗色+删除线）/ `○ pending`；超 5 条优先 in_progress、兼顾最早 pending 和最近 done）；一轮结束全部 done 自动收起；会话恢复时以 `agent.tasks` 直接初始化。状态栏保留 `▶done/total` 计数，对话区每次更新留痕 `[task] x/y ▶ 当前任务`。chat 命令经 stderr 输出同款留痕。

**token 用量展示**：`readSSE` 捕获 `usage` → runAgent 经 `callbacks.onUsage` 透传 → TUI 状态栏累计显示 `↑输入 ↓输出 hit 缓存命中率%`（DeepSeek usage 自带 `prompt_cache_hit/miss_tokens`，前缀缓存效果因此可观测）；chat 命令结束时 stderr 输出 `[usage]` 汇总行。状态栏另显示**上下文利用率** `ctx N%`（`estimateTokens(history) / compactThreshold`，history 长度变化才重算；≥80% 变黄——到 100% 触发压缩，提醒用户收尾或 /new）。

### context.mjs — 上下文管理 + 压缩

```js
export function createContext({ systemPrompt, maxTokens })
export function add(ctx, message)           // 追加消息
export function messages(ctx)               // 取当前消息列表
export async function compress(ctx, provider)  // 超阈值时压缩
```

压缩策略（学 kimi-code，简化版）：保留 system + 最早 2 条 + 最近 N 条，中间用 LLM 摘要成一条。token 判定**实测优先**：上次响应的 `usage.prompt_tokens` 是完整上下文（system+tools+history）的实测值，之后追加的消息用估算补增量；无实测（首轮/恢复后/刚压缩完）退化为估算（ASCII/4 + 非 ASCII/1——纯 `length/4` 对 CJK 低估 3-4 倍，可能永远来不及压缩）。安全点是 user **或 tool** 结尾（splitHistory 保证 tool_calls 配对完整；只认 user 会让纯工具长跑迟迟得不到压缩机会）。摘要 LLM 连续 3 次失败降级为确定性截断（`compressFallback`，丢 middle 不碰网络——丢信息好过任务被 400 打死）。压缩后以独立 system reminder 回注 task 列表与 plan 状态、重置提醒计数器——每次压缩先清掉旧回注再注入最新版，task 状态永远最新且位于历史末尾（单一信息源，不嵌入摘要正文避免重复）。会话持久化分两套数据，互不牵扯——**agent 恢复**要上下文连续（history：压缩过、transient 过滤，可牺牲保真）；**用户恢复**要所见即所得（display：TUI 对话区渲染行 {text,color} 原样快照，含工具结果/task 留痕/思考链；复用 history 重建显示必然失真——摘要会替换原文）。临时上下文（目录快照/记忆注入）注入时打 `transient` 标记，保存按标记过滤（旧存档按文本前缀在加载时清理）；原子写（tmp+rename）；每 5 个工具 turn 增量保存（`onTurnEnd` 钩子）；`_sessionStart` 随会话带回，跨重启 system prompt 逐字节稳定保住前缀缓存。

### memory.mjs — 记忆（扩展位 ⭐）

```js
// 接口——v1 单机实现，v2+ 换团队实现，调用方无感：
export function createMemory({ dbPath })             // 打开/初始化
export async function put(memory, entry)             // entry: { type, title, content, tags }
export async function search(memory, query, { limit })  // FTS5 检索, v1 无向量
export async function list(memory, { type, limit })
export async function remove(memory, id)
```

- v1 实现：`node:sqlite` + FTS5 虚表，BM25 排序。entry.type ∈ `rule | knowledge | decision | pattern`（对齐团队记忆四类内容）
- **扩展位设计**：`createMemory` 返回的对象即接口。v2 团队版 = 同一接口 + git 同步层 + 向量检索（embedding 走 provider 的 fetch）+ RRF 排序，单机版无痛升级
- agent 集成：system prompt 里注入 `search` 结果 + 提供 `memory_put` / `memory_search` 两个工具让 agent 自主存取

### config.mjs — 配置

```js
export function loadConfig()    // 读 ~/.thincoder/config.json + 环境变量兜底
export function saveConfig(config)
```

```jsonc
// ~/.thincoder/config.json
{
  "provider": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "...", "model": "deepseek-chat" },
  "agent": { "maxTurns": 100, "compactThreshold": 100000 },
  "memory": { "dbPath": "~/.thincoder/memory.db" }
}
```

apiKey 也可走环境变量（`THINCODER_API_KEY` 或 provider 惯用变量），配置文件不明文存储时可留空。

### tui.mjs — 裸 ANSI 终端 UI

```js
export async function startTUI(agent)   // 主入口，接管终端直到退出
```

自研范围（~24 个模块，约 3,000 行）：
- raw mode 输入：按键解析（可打印字符、方向键、Ctrl 组合、粘贴）
- 渲染：对话区（流式追加）+ 输入区 + 状态栏，全屏重绘走 alternate buffer
- 宽字符：CJK/emoji 宽度计算（`String.prototype.codePointAt` + 简单 EastAsian 表，不引 wcwidth 依赖）
- 权限确认：写文件/bash 前弹出 y/n 提示

### bin/thincoder.mjs — 命令分发

```
thincoder              # 启动 TUI（默认）
thincoder chat "..."   # 一次性问答（管道友好，可接 stdout）
thincoder memory       # 记忆管理子命令（list/search/put/remove）
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
