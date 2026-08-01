# 工程模式（Engineering Mode）设计

> 工程模式是 thincoder 的严格方法论工作流：design-before-code、METHODOLOGY 驱动、双门禁（设计评审 + 代码评审）机械强制。
> 实现：`src/agent/setup.mjs`（提示词装配）、`src/agent/dispatch.mjs`（写文件门禁）、`src/agent-tools/subagent.mjs`（eng-coder spawn + token 校验 + 修改合并）、`src/agent-tools/advisor.mjs`（design review + token 签发）、`src/prompts/engineering*.md`（流程提示词）。
> 与 advisor 收敛协议的关系见 [ADVISOR-CONVERGENCE.md](ADVISOR-CONVERGENCE.md)。

## 目标

普通模式靠纪律提示词约束模型；工程模式进一步把"设计先行、评审把关、验证收尾"提升为**半机械流程**——凡可硬性拦截的环节一律拦截（写文件门禁、token 校验、guard 推回），凡无法硬拦的环节靠 METHODOLOGY 与提示词约束（父代理行为）。

## 角色模型

| 角色 | 职责 | 机械约束 |
|---|---|---|
| **父代理**（顶层，`role` 未定义） | 架构师：写设计文档 → 设计评审 → 用户批准 → 委托实现 → 代码评审 → 验证 | 无写文件门禁（需写 docs/）；受工程提示词约束（信任模型） |
| **eng-coder**（子代理，`role="eng-coder"`） | 实现者：按设计文档实现、小步 verify、报告 | 全机械：spawn 需 token、写文件需 `_engDesignReviewed`、返回后改动合并进父代理触发 code review |

## 主流程

```
1. 写设计文档 docs/（问题陈述、方案、受影响文件清单、可验证验收标准）
2. advisor(type="design") 设计评审（独立上下文）
   ├─ 有 🔴 → 修设计重提，循环
   └─ 无 🔴 → 回显 [DESIGN-TOKEN:...] → 签发 _engDesignToken + _engDesignReviewed（eng-coder 角色）
3. 用户批准设计
4. subagent(role="eng-coder", designToken=token)
   ├─ 机械校验 parent._engDesignToken === token，不符即 throw
   └─ spawn 成功 → child._engDesignReviewed = true（解锁写文件）
5. eng-coder 实现（内部有 advisor/verify 工具；无机械 guard，靠 eng-coder.md 提示词约束）
6. 返回时 mergeChildMutations：子代理改动合并进父代理
   ├─ _mutatedThisRun = true、_touchedFiles 去重合并
   └─ 使父代理先前 verify/advisor 标记失效（评审的是旧状态）
7. 父代理 advisor(type="code") 代码评审 —— guard 机械推回直至完成
8. 父代理 verify —— engineering 模式下 guard 等效 verifyGuard: true
9. 完成
```

## 机械强制链（三道闸）

| 闸 | 机制 | 位置 |
|---|---|---|
| **Design gate** | ① spawn 时 token 校验（`parent._engDesignToken === designToken`，不符即拒）；② 写文件门禁：`_role==="eng-coder" && !_engDesignReviewed` → 拒绝 + 提示先做设计评审 | subagent.mjs L53-57；dispatch.mjs L74-82 |
| **Code gate** | eng-coder 改动合并进父代理后，advisor guard（`_mutatedThisRun && !_calledAdvisorThisRun && touchedFiles>0`）机械推回，直到 code review 完成；engineering 模式豁免 runAdvisorReview 的空 touchedFiles 检查（review 必然可跑）。`mergeChildMutations` 同时重置 `_advisorRound = 0`——合并的代码是新代码，享有全新收敛预算（防父代理 spawn 前积累轮次导致 cap 死锁） | subagent.mjs mergeChildMutations；agent.mjs L310+；advisor/run.mjs L165 |
| **Verify gate** | engineering 模式下 verify guard 与 `verifyGuard: true` 等效（`verifyGuard === true \|\| engineering`），完成前必须 verify；verify 用 `git diff` 检测改动，子代理改动同样可见 | agent.mjs L266 |

**轮次隔离**：design review（`type="design"`）不递增 `_advisorRound`——设计评审是独立门禁，不消耗 code 收敛轮次（MAX_ADVISOR_ROUNDS=5）预算，且豁免 cap。design 调用时重置 `_advisorRound`/`_advisorSession`/`_advisorLastSnapshot`，防止状态泄漏进后续 code review。

## Token 生命周期

- 签发：advisor 工具在 design review 通过（advisor 回显 `[DESIGN-TOKEN:...]`，机械字符串匹配）时设置 `agent._engDesignToken`。
- 存活：会话内跨 turn 存活——TUI 用户批准设计是新的 runAgent 调用，token 必须跨过去。
- 失效：任何后续 design review 失败（`result !== null` 且无 token 回显）即清空。
- 消费：不消费（一个设计可 spawn 多个 eng-coder 并行实现不同模块）。
- **已知保守缺口**：token 不随任务结束自动作废，极端情况下可从历史中复用——接受（需要模型既违反工程提示词又提取旧 token，实际风险低）。
- 会话恢复（`saveSession`/resume）不持久化 token——resume 后需重新设计评审（安全偏向）。

## 边界（信任模型）

- **eng-coder 全机械约束**：token 校验、写文件门禁、改动合并、code review/verify 推回。
- **父代理提示词约束**：不设写文件门禁（父代理必须能写 docs/ 设计文档）。父代理越权（跳过设计直接写代码）依赖 engineering.md 提示词约束——这是刻意的设计选择，与普通模式纪律约束同构。
- METHODOLOGY.md 缺失时降级：`setup.mjs` 检测不到文件 → 使用标准纪律提示词 + 顶层注入警告（"Engineering constraints are NOT in effect"）；机械闸仍生效（config.engineering=true 不变），行为一致但无方法论约束。

## 配置

```json
{ "agent": { "engineering": true } }
```

- 默认 false（config.mjs）。
- TUI `/eng` 命令切换（`src/tui/cmd-eng.mjs`），持久化到配置。
- 依赖：项目根 `METHODOLOGY.md`（工程约束来源）；`advisor` 配置可选覆盖（`provider`/`model`），engineering 模式下评审强制、不受 `advisor.enabled=false` 影响。
- 角色互斥：工程模式禁用 `coder`（subagent 工具 schema 按模式替换枚举），普通模式禁用 `eng-coder`。

## 会话恢复

`saveSession` 持久化 `engineering` 标志；不持久化 `_engDesignToken`/`_engDesignReviewed`/`_advisorRound`（内存态）。resume 后工程模式保持开启，但未完成的设计授权需重新评审。

**resume（ContinueError 续跑）语义**：`runAgent` 在 `resume: true` 时**保留**全部 run 状态（`_mutatedThisRun`/`_touchedFiles`/`_calledAdvisorThisRun`/`_verifiedThisRun`/`_advisorRound`/`_advisorSession`）——guard 推回发生在最后一轮时不会被静默清除，收敛预算也不能靠 continue 无限重置。新任务（非 resume）才重置。

## 验证

- `test/agent.test.mjs`：`mergeChildMutations`（合并/去重/标记失效/无改动不变）、subagent 权限流。
- `test/advisor.test.mjs`：design 不递增轮次、cap 对 design 豁免、prior 表行级提取防幻影。
- 端到端流程依赖 LLM，由工程提示词 + 机械闸共同保证，无单测覆盖完整链路——机械闸每个环节均有对应单元测试。

## 已知取舍（评审记录）

1. 父代理无写文件门禁——必须能写设计文档；越权靠提示词。
2. token 跨任务存活——保守缺口，已接受。
3. resume 丢 token——安全偏向重新评审。
4. multi-repo 时 advisor cwd 取 `repos[0]`——`_touchedFiles` 存绝对路径缓解，已知限制。
