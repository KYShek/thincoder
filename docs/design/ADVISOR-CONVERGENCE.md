# Advisor 收敛协议（Convergence Protocol）

> 本文档记录 advisor 审查的收敛机制设计。实现：`src/advisor.mjs`（消息构建）、`src/advisor/run.mjs`（执行/上限）、`src/prompts/advisor-round*.md`（轮次提示词）。

## 目标

独立审查在"审查 → 修复 → 复审"循环中必须**收敛**：要么确认全部问题已修复（passed），要么在有限轮次内终止。历史上出现过 advisor 反复执行、每轮都报新问题、永不收敛的问题，以下机制均为其修复产物。

## 轮次定义

| 轮次 | system prompt | 检查范围 | 新问题权限 |
|---|---|---|---|
| Round 1 | `advisor-round1.md` | 全量审查（读约定文档、追踪调用方） | ✅ 任意问题，建立 issue 表 |
| Round 2 | `advisor-round2.md` | 以验证 prior 表为主 | ⚠️ 仅限 diff 明显可见且导致 crashes / data loss / logic errors 的新问题 |
| Round 3–5 | `advisor-round3.md` | 严格只验证 prior 表 | ❌ 禁止（Do NOT look for new issues） |

轮次映射（`buildAdvisorSystemPrompt`）：`_advisorRound` 在每次 advisor 工具调用成功后 +1（`agent.mjs`），调用时 `_advisorRound=0 → ROUND1`，`=1 → ROUND2`，`≥2 → ROUND3`。注意 `_advisorRound` 是**已完成的** advisor 调用次数，`buildAdvisorSystemPrompt` 用 `_advisorRound + 1` 推导即将进行的轮次号——两者相差 1，勿混淆。

## 关键机制

### 1. system prompt 按轮次替换（核心修复）

会话续接路径（`prepareAdvisorMessages`）在每轮追加 follow-up user 消息的同时，**替换 `session[0]` 的 system prompt** 为对应轮次版本。

历史教训：修复前 system prompt 冻结在 ROUND1（"full-scope review"），收敛约束只存在于 user 级 follow-up 消息，system 权重压过 user → 模型每轮都全量扫描挑新问题 → 永不收敛。ROUND2/3 提示词文件一度是死代码。

### 2. 机械轮次上限

`MAX_ADVISOR_ROUNDS = 5`（`run.mjs`）。第 6 次 code review 调用直接返回终止消息（"convergence cap reached"），不消耗 LLM。设计评审（`reviewType="design"`）豁免——每次调用重置轮次，单遍评审无收敛需求。空 `_touchedFiles` 检查在 cap 检查**之前**，保证诊断信息准确。

### 3. stale-context 加固

history 中旧消息嵌有历史 diff，模型可能把"被删除的旧代码"误判为当前状态（曾连续两轮报告已修复的旧问题）。防护：

- ROUND2/3 system prompt 与 follow-up user 消息均声明 **STALE-CONTEXT WARNING**：更早消息中的 diff 全部过期，仅以本轮 "Current Changes" 和实时 `read` 为准。
- **证据强制**：任何 "Unfixed" / "New" 判定必须附 `read` 验证的 `file:line` 证据；无证据的判定视为未验证、不予接受。

### 4. 会话生命周期

- 同一次 run 内所有 advisor 调用共享一个会话（`agent._advisorSession`），round 2+ 只追加 follow-up（agent 响应表 + 刷新 diff + 轮次规则），保留探索上下文。
- run 结束（`runAgent`）重置 `_advisorRound`、`_advisorSession`、`_advisorLastSnapshot`（diff 去重基线）。
- 审查失败清空会话（防止半成品上下文泄漏），下次调用按 `_advisorRound` 重建并选择正确轮次 prompt。
- prior 表为空（上次 all-clear 或首次）时重置为 round 1 全新全量审查。

## 配置

`.thincoder/advisor.md` 提供评审准则覆盖；`config.json` 中 `advisor.provider` / `advisor.model` 可选覆盖主 agent 的 provider。

## 工程模式（engineering mode）集成

工程模式（`agent.engineering: true`）承诺 "Advisor is mandatory at both design and code gates"，机械强制链如下：

- **Design gate（机械强制）**：spawn `eng-coder` 时 `subagent.mjs` 校验 `parent._engDesignToken === designToken`，不符即拒绝；`dispatch.mjs` 的写文件门禁以 `_engDesignReviewed` 为兜底，advisor 工具在 design review 通过（token 回显）时同步置位——两套机制联动，任何未经授权路径都无法写文件。
- **Code gate（机械强制）**：eng-coder 返回后 `mergeChildMutations`（subagent.mjs）把子代理的修改合并进父代理（`_mutatedThisRun`/`_touchedFiles`，并使先前 verify/advisor 标记失效）——父代理的 advisor guard 因此触发，无法通过"把所有改动委托给 eng-coder"跳过代码评审。
- **Verify（机械强制）**：工程模式下 verify guard 与 `verifyGuard: true` 等效，父代理完成前必须 verify（verify 用 `git diff` 检测，子代理改动同样可见）。
- **轮次隔离**：design review（`type="design"`）不递增 `_advisorRound`——设计评审是独立门禁，不消耗 code 收敛轮次（MAX_ADVISOR_ROUNDS）预算，也不会污染后续 code review 的轮次显示。
- **Token 生命周期**：`_engDesignToken` 在会话内跨 turn 存活（TUI 用户批准设计是新的 runAgent 调用，token 必须跨过去）；任何 design review 失败会使其失效（agent-tools/advisor.mjs）。已知的保守缺口：token 不随任务结束自动作废，极端情况下可从历史中复用——接受（需要模型既违反工程提示词又提取旧 token，实际风险低）。
- **机械强制的边界**：机械闸（token 校验、写文件门禁、guard 推回）作用于 **eng-coder 子代理**；**父代理本身不受写文件门禁约束**——它需要写设计文档（docs/），且工程提示词（engineering.md）约束其"设计先行、委托实现、实现后必须 code review"。父代理的越权（跳过设计直接写代码）只能靠提示词约束，这是信任模型的设计选择，与普通模式的纪律约束一致。

## 验证

`test/advisor.test.mjs` 覆盖：system prompt 轮次替换、cap 阻断第 6 次调用、design 豁免、design 不递增轮次、follow-up 内容、prior 表提取等；`test/agent.test.mjs` 覆盖 `mergeChildMutations` 合并/去重/标记失效。全套测试 `node --test test\*.test.mjs`。
