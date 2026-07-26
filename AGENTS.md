# AGENTS.md — ThinCoder 项目指引

## 项目概述

零依赖 AI 编码 CLI：纯 Node.js >= 24 标准库、无构建步骤、ESM（`.mjs`）。
LLM 走 OpenAI 兼容协议（`provider.mjs` 原生 fetch + SSE 流式），只跟国内顶流厂商旗舰模型（DeepSeek / Kimi / GLM / Qwen / MiniMax）。
设计文档在 `../thincoder-design/`（REQUIREMENTS.md / ARCHITECTURE.md / ARCHITECTURE-v2.md）。

## 硬性约束

- **零 npm 运行时依赖**：只用 `node:` 标准库（存储用 `node:sqlite`，终端用裸 ANSI）。新功能先想标准库能不能做，做不到再提出来讨论
- 无 TypeScript、无任何构建/打包步骤
- 所有改动必须实际跑过验证，不留"写了没跑"的代码

## 设计原则（完整见 ../thincoder-design/ARCHITECTURE.md#设计原则）

1. **零依赖** — 每引入一个 npm 包就引进一份技术债
4. **准比短重要** — 上下文宁长勿缺，1M 窗口是常态
5. **代码是问题，不是答案** — 别把现有代码当权威
6. **面向全球，不做中文限定** — 代码和 TUI 均为英文

## 验证

```bash
npm test    # node:test 离线测试，113 条，不碰网络/真实 API；改动必须全绿
```

TUI 交互路径（权限审批、todo 面板、压缩提示、状态栏）无离线覆盖，发布前走人工冒烟（见下文「发布」）。

## 结构

```
bin/thincoder.mjs   命令入口与分发（chat/memory/sync/distill/reindex/upgrade/-v）
src/agent.mjs       主循环 + 自律工具（task/plan/goal/verify/subagent/skill/recent_changes）
                    + 提醒注入（task/goal/plan/模式切换）+ 完成守卫 + 修复-验证循环
                    + 增量索引（write/edit/delete 后自动 reindexFile）+ 依赖摘要注入
src/provider.mjs    LLM 调用（SSE、reasoning_content、usage、重试 + TPM/RPM 主动节流闸门）
src/tui.mjs         裸 ANSI TUI（对话区 / todo 面板 / 输入框 / 状态栏 / 选择器 / 子 agent 面板）
                    斜杠命令全部改为列表游标选择
src/tools.mjs       20+ 文件/网络/git 工具；描述存 src/tools/*.md
                    文件修改后自动 node --check 增量语法检查
src/context.mjs     上下文压缩（压缩前保存关键决策，压缩后回注 task/plan 状态）
src/memory.mjs      三层记忆（personal/project/team）+ 代码/文档索引（code_chunks + doc_chunks，FTS5 + 向量 RRF）
                    + JSDoc/docstring 提取 + 单文件增量索引
src/repomap.mjs     仓库依赖大纲（import/export 解析，紧凑摘要 + 按需全量）
src/session.mjs     会话持久化（最多 5 个归档槽位）
src/embedding.mjs   向量嵌入（SiliconFlow bge-m3 / 通用 OpenAI /v1/embeddings）
src/mcp.mjs         MCP client（stdio + HTTP + WebSocket）
src/config.mjs      配置加载 + provider 预设管理
src/checkpoint.mjs  git 存档点（快照 → 回滚）
src/skills.mjs      项目技能加载
src/markdown.mjs    frontmatter 解析（零依赖）
src/distill.mjs     会话知识提取
src/gitmem.mjs      Team 层 git 同步
src/SYSTEM_PROMPT.md   核心提示词（主/子 agent 通用）
src/main-overlay.md    主 agent 专属条款（subagent/goal/verify/skill/plan mode）
src/{explore,coder,plan}-overlay.md   子 agent 角色文本
test/units.test.mjs   全部离线测试（含 mock LLM server 驱动的 runAgent 端到端）
```

## 关键设计约束（改动前必读）

- **前缀缓存**：system prompt 必须跨 run 逐字节稳定——只能放按 cwd/会话稳定的内容；每轮变化的内容（如记忆注入）必须走独立 user 上下文消息。往 system prompt 加动态内容会打破 DeepSeek context caching
- **thinking 回传**：带 tool_calls 的 assistant 消息是否回传 `reasoning_content` 由规格表 `reasoningEcho` 决定——`"required"`（DeepSeek/Kimi K3）必须回传；`"optional"`（GLM）不回传；未声明保守不回传
- **提醒注入**统一格式：`role: "user"` 的 `[System reminder: ...]`；task 闲置提醒仅顶层 agent（depth=0）注入；用户/外部文本注入前必须 XML 转义 + `<untrusted_*>` 标签包裹
- **工具结果**超 16k 字符自动落盘 `~/.thincoder/tool-results/`，模型只见预览 + 路径
- **代码库理解**：三个检索工具——`repo_outline`（依赖图）、`code_search`（源码 FTS5 + 向量）、`doc_search`（文档按标题分块）。提示词指引模型按"结构→意图→细节"顺序使用
- **文件修改后自动增量索引**：`reindexFile` 在 write/edit/delete 后运行
- **修复-验证循环**：改完文件未 verify 自动推验证；verify 跑 `node --check` + `npm test`；失败最多 3 轮修复

## 提交与发布

- commit message：`type: 摘要`（feat / fix / release / docs），英文单行；release 提交正文附变更清单
- 发布流程：改 `package.json` 版本号 → `npm publish`（`prepublishOnly` 自动跑全量测试）→ commit + `git tag vX.Y.Z` → `git push origin main --tags`
- 发布前人工冒烟（约 5 分钟）：
  1. TUI 里给一个需要写文件的任务 → 权限审批展示内容预览（黄色），批准后有落痕
  2. 给一个多步任务 → todo 面板出现，done 项带删除线，全部完成后自动收起；状态栏有计数
  3. 长对话触发压缩 → 出现 `[context]` 提示，任务状态保留
  4. 状态栏 token 用量（`↑x ↓y hit z%`）与上下文利用率随请求增长
  5. `thincoder -v` 输出与 package.json 一致的版本号；`thincoder chat "..."` 一次性问答正常
