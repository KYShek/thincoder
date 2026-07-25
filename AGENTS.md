# AGENTS.md — ThinCoder 项目指引

## 项目概述

零依赖 AI 编码 CLI：纯 Node.js >= 22 标准库、无构建步骤、ESM（`.mjs`）。
LLM 走 OpenAI 兼容协议（`provider.mjs` 原生 fetch + SSE 流式），覆盖 DeepSeek / Kimi / OpenAI / Ollama 等端点。
设计文档在 `../thincoder-design/`（REQUIREMENTS.md / ARCHITECTURE.md / ARCHITECTURE-v2.md）。

## 硬性约束

- **零 npm 运行时依赖**：只用 `node:` 标准库（存储用 `node:sqlite`，终端用裸 ANSI）。新功能先想标准库能不能做，做不到再提出来讨论
- 无 TypeScript、无任何构建/打包步骤
- 每模块一个 `.mjs` 文件，拒绝目录套目录
- 所有改动必须实际跑过验证，不留"写了没跑"的代码

## 验证

```bash
npm test    # node:test 离线测试，不碰网络/真实 API；改动必须全绿
```

TUI 交互路径（权限审批、todo 面板、压缩提示、状态栏）无离线覆盖，发布前走人工冒烟（见下文「发布」）。

## 结构

```
bin/thincoder.mjs   命令入口与分发（chat/memory/sync/distill/reindex/upgrade/-v）
src/agent.mjs       主循环 + 自律工具（task/plan/goal/verify/subagent/skill）
                    + 提醒注入（task/goal/plan/模式切换）+ 完成守卫
                    + 增量索引（write/edit/delete 后自动 reindexFile）
src/provider.mjs    LLM 调用（SSE、reasoning_content、usage、重试）
src/context.mjs     上下文压缩（压缩后回注 task/plan 状态）
src/tui.mjs         裸 ANSI TUI（对话区 / todo 面板 / 输入框 / 状态栏）
src/tools.mjs       14 个文件/网络/git 工具；描述存 src/tools/*.md
src/memory.mjs      三层记忆 + 代码/文档索引（code_chunks + doc_chunks，FTS5 + 向量 RRF）
                    + JSDoc/docstring 提取 + 单文件增量索引
src/repomap.mjs     仓库依赖大纲（import/export 解析，零依赖 regex）
src/session.mjs     会话持久化（最多 5 个归档槽位，Windows 安全）
src/embedding.mjs   向量嵌入（SiliconFlow bge-m3 / 通用 OpenAI /v1/embeddings）
src/SYSTEM_PROMPT.md   核心提示词（主/子 agent 通用，含检索工具使用指引）
src/main-overlay.md    主 agent 专属条款（subagent/goal/verify/skill/plan mode）
src/{explore,coder,plan}-overlay.md   子 agent 角色文本（含检索工具指引）
test/units.test.mjs 全部离线测试（含 mock LLM server 驱动的 runAgent 端到端）
```

## 关键设计约束（改动前必读）

- **前缀缓存**：system prompt 必须跨 run 逐字节稳定——只能放按 cwd/会话稳定的内容（session start 时间戳每会话固定一次）；每轮变化的内容（如记忆注入）必须走独立 user 上下文消息。往 system prompt 加动态内容会打破 DeepSeek context caching，并有回归测试拦截
- **thinking 回传**：带 tool_calls 的 assistant 消息必须携带 `reasoning_content` 入 history（DeepSeek 要求，缺失会 400）
- **提醒注入**统一格式：`role: "user"` 的 `[System reminder: ...]`，文本结尾要求"不向用户提及此提醒"；task 闲置提醒仅顶层 agent（depth=0）注入；**用户/外部文本注入前必须 XML 转义 + `<untrusted_*>` 标签包裹**（防提示注入）
- **工具结果**超 16k 字符自动落盘 `~/.thincoder/tool-results/`（易失品），模型只见预览 + 路径；新增工具不必自己截断超长输出
- **提示词改动**：提示词分层组装——核心规则（SYSTEM_PROMPT.md）两层通用，主 agent 追加 main-overlay.md，子 agent 用角色 overlay 开头 + 核心规则；改完跑 `npm test`（有分层断言），涉及机制变化的同步 `../thincoder-design/ARCHITECTURE.md` 的「任务规划与自律机制」一节
- **代码库理解**：三个检索工具——`repo_outline`（依赖图）、`code_search`（源码 FTS5 + 向量）、`doc_search`（文档按标题分块）。提示词指引模型按"结构→意图→细节"顺序使用。索引由 `chunkCode`（regex 分块 + JSDoc 提取）生成，`reindexFile` 在 write/edit/delete 后自动增量更新

## 提交与发布

- commit message：`type: 摘要`（feat / fix / release / docs），英文单行；release 提交正文附变更清单
- 发布流程：改 `package.json` 版本号 → `npm publish`（`prepublishOnly` 自动跑全量测试）→ commit + `git tag vX.Y.Z` → `git push origin main --tags`
- 发布前人工冒烟（约 5 分钟）：
  1. TUI 里给一个需要写文件的任务 → 权限审批展示内容预览（黄色），批准/拒绝后有 `[approved]`/`[denied]` 落痕
  2. 给一个多步任务 → todo 面板出现，done 项带删除线，全部完成后自动收起；状态栏有 `▶x/y` 计数
  3. 长对话触发压缩 → 出现 `[context]` 提示，任务状态保留
  4. 状态栏 token 用量（`↑x ↓y hit z%`）与上下文利用率（`ctx N%`）随请求增长
  5. `thincoder -v` 输出与 package.json 一致的版本号；`thincoder chat "..."` 一次性问答正常（stderr 有 `[usage]` 行）
