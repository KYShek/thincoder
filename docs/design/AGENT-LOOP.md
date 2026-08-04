# Agent 主循环设计（thincoder/src/agent.mjs + agent/）

> 状态：2026-08 回补。LLM ↔ 工具调用循环：回合驱动、guard 体系（pending tasks / verify / advisor / 诚实声明）、中断语义、子代理、压缩/用量锚点、停滞检测、goal 预算。

## 1. 模块地图

| 文件 | 职责 |
|---|---|
| `agent.mjs` | runAgent 主循环：prepareRun → turn 循环 → chat → 分发 → 后处理；ContinueError/resume；usage 基线 |
| `agent/setup.mjs` | prepareRun：上下文注入（git/目录/指令/记忆/文档/outline）、system prompt 组装、阈值解析 |
| `agent/dispatch.mjs` | executeToolCalls：两段调度（权限预审 → 顺序保序执行）、hooks、错误落盘 |
| `agent/completion.mjs` | handleCompletion：零工具调用回合的 guard 链（pending → verify → advisor → 收尾） |
| `agent/post-turn.mjs` | 回合后注入：停滞检测、goal 预算预警 |
| `agent/helpers.mjs` | 常量（turn 上限、结果落盘阈值）、escapeXml、repairHistory、git 上下文、目录树 |
| `auto-think.mjs` | 任务难度分类 → 自动设置 reasoning effort（opt-in） |

## 2. runAgent 主循环

```
runAgent(agent, input, callbacks, { depth, signal, maxTurns, resume })
  1. prepareRun：注入上下文 + 组装 systemPrompt/tools/schema + 阈值（详见 §3）
  2. 非 resume 时重置 per-run 状态（mutation/verify/advisor/touchedFiles/emptyRetries/compressFailures）
  3. turn 循环（≤ maxTurns，默认 100；goal 模式 200；子代理 100）：
     a. 压缩检查（仅 lastRole ∈ {user, tool} 安全点；见 CONTEXT-COMPACTION.md）
     b. plan-mode 提醒节流注入、工程模式状态注入
     c. autoThink 分类（turn 0 且配置开启）
     d. chat()（流式；onToken/onReasoning/onWait 透传；streamRules 共享 firedPatterns）
     e. 响应后处理：流规则 abort/warn、用户中断（Ctrl+I）、usage 基线、异常 finishReason 提醒
     f. 有 toolCalls → executeToolCalls（§4）→ 结果回喂 → 回到 a
       无 toolCalls → handleCompletion（§5）→ done / continue（guard 推回）
  4. 超 turn 上限 → throw ContinueError（TUI 询问是否续跑，续跑走 resume 保状态）
```

**中断语义**（AbortController + signal.reason）：
- `controller.abort()`（Ctrl+C abort / /abort）：当前 chat 抛 AbortError → runAgent 直接上抛，不提交半截历史
- `controller.abort({ interrupt: true, message })`（Ctrl+I）：chat 中断 → 提交部分输出（pushReal）+ 注入 `[User interrupt: message]` → 抛 AbortError；**agent-turn 捕获后重建 controller 续跑**——同一轮内继续，用户消息即时生效
- 工具执行期间中断：`signal.reason.interrupt` → 不提交半截工具结果，注入中断消息后 continue（下一 turn 重新生成）

**resume（ContinueError 续跑）**：`agent._mutatedThisRun/_verifiedThisRun/_verifyRetries/_touchedFiles/_advisorRound` 等 **保留**——guard 连续性和收敛预算不能被续跑重置；`_emptyRetries/_compressFailures` 也保留（预算跨 turn 计数，防刷）。

## 3. prepareRun 上下文注入（setup.mjs）

按序注入（全部 `role: "user"` 机读消息，带 `transient` 标记的落盘时过滤）：
1. **git 上下文**（顶层）：分支、最近 5 条提交、未提交改动清单（非 git 仓库静默跳过）
2. **目录树**（顶层）：`listWorkDir`（根 ≤30 项、子目录 ≤10 项，隐藏折叠，超限截断）
3. **项目指令**：AGENTS.md / CLAUDE.md / project_rules.md（≤32K 字符，`<untrusted_project_instructions>` 包裹）
4. **记忆检索**：`memory_search(input)` 前 3 条（`<untrusted_memory>` 包裹 + XML 转义）
5. **文档检索**：doc_search 前 5 条 chunk（`<untrusted_doc_chunk>` 包裹）
6. **依赖大纲**：repomap 输出（`OUTLINE_INJECT_PREFIX`）
7. 用户输入（pushReal：双线）
8. 多模态图像（视觉模型：附加到首条 user 消息）

**system prompt 字节稳定**（前缀缓存契约）：跨 run 逐字节不变——每轮变化的记忆/文档注入走 user 上下文消息而非 system；`Session start` 时间戳每会话固定一次（`_sessionStart`）。有回归测试断言两次请求 system 消息逐字节相等。

## 4. 工具调度（dispatch.mjs，两段式）

**Phase 1 预审**（全部 toolCalls 先过一遍，任一被拒不影响其他）：
```
JSON 参数解析失败 → error
未知工具 → error
planMode && 非只读 → denied "plan mode"
eng-coder && 未过设计评审 && FILE_MUTATORS → denied "engineering design gate"
父 agent && 工程模式 && 无设计 token && 触及代码文件 → denied（docs/ 与根级文档豁免）
非只读 && !autoApprove → onPermissionRequest（用户确认）；无 handler → denied
PreToolUse hooks → 阻断
```
**Phase 2 执行**（**顺序保序**）：只读工具 + `parallel` 标记的工具可并行（Promise.all 一批），非只读工具**打断批量串行**（先 flush 再单独执行）——保证顺序语义且允许只读并行。执行前副作用工具 `snapshotForUndo`（/undo 回滚基线）；结果 >16K 字符落盘 `~/.thincoder/tmp/` + 2K 预览；错误写入 `~/.thincoder/tool-errors/`（模型只见 message + 关键参数，不见 stack trace 防路径泄露）；PostToolUse 钩子 fire-and-forget。

## 5. 零工具调用回合（completion.mjs handleCompletion）

顺序（每个 guard 推回一次后 continue，直到通过）：
1. **空响应恢复**（IK60QP）：`!response.content` → 注入 `[System reminder: your last response was empty…]` 重试，上限 `MAX_EMPTY_RETRIES=2`（每次用户消息重置），仍空才抛原错误（含 /think 降档建议）
2. **pending tasks 提醒**：有 pending → 注入任务列表提醒并继续循环（模型更新 task 状态后再收尾）；**最多推回一次**（`_taskPushbacks`，task 工具更新列表即重置）——模型第二次坚持收尾则放行，避免 pending 项无法解决时无限循环
3. **verify guard**（opt-in `verifyGuard: true`，工程模式除外）：改过代码未 verify → 推回调 verify（≤2 次）；verify 失败 → 推回修复（≤3 次）；耗尽 → 诚实声明提醒（必须说明哪些测试失败/试了什么/根因）
4. **advisor guard**（opt-in `advisor.enabled && guard !== false`，工程模式除外）：改过代码未评审 → 推回调 advisor（≤3 轮，收敛协议见 ADVISOR-CONVERGENCE.md）
5. 通过 → pushReal assistant 回复 + 返回 content

## 6. 回合后注入（post-turn.mjs）

- **停滞检测**：同一工具+同一参数序列化签名连续 3 次 → 注入"你在原地空转，换条路或求助"（窗口 5）
- **goal 预算**：goal 活跃时每轮注入目标/已用 turn 数；用满 75% 时预警；`goal complete` 需验证证据门槛（见 goal 工具）

## 7. 子代理（subagent 工具）

- `depth > 0`：独立 agent 对象 + 丢弃式局部双线；role（explore/plan/coder/eng-coder）决定工具集（只读过滤）与 overlay prompt
- 流式 relay：`role#id/` 前缀 token 转发给父回调（TUI subTasks 面板 / VS Code subagent 面板）
- 报告契约：<200 字符视为交接不完整，打回扩写一次（`MIN_REPORT_CHARS`）；超长报告落盘全量保留
- 权限：手动模式下子代理的非只读工具透传到父 agent 的权限审批（人在回路）
- eng-coder：设计 token 门控（`_engDesignToken`，评审通过后签发，跨 turn 存活；子代理授权在 spawn 前校验）

## 8. 关键设计决策

| 决策 | 理由 |
|---|---|
| guard 链全部"注入提醒 + continue"而非硬中断 | 模型自我修正优于外部强制；计数上限防死循环 |
| verify/advisor 仅 opt-in | 默认不打扰（对齐用户偏好；工程模式用流程驱动评审替代逐轮推回） |
| 中断=提交部分输出+注入消息+续跑 | Ctrl+I 语义是"插话"不是"取消"——上下文连贯 |
| resume 保留 guard 状态 | 续跑不能重置已验证/收敛事实，否则可被无限续跑绕过 |
| 两段调度顺序保序 | 只读并行提速，副作用严格串行保因果 |
| 错误落盘不落模型 | stack trace 泄露路径且干扰推理；`~/.thincoder/tool-errors/` 供事后分析 |
