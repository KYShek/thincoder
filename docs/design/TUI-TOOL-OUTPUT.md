# TUI 工具输出统一

> 状态：设计（待批准）

## 1. 需求（Requirements）

### 1.1 总体需求

当前 TUI 的工具输出存在双轨（面板流式 vs 行间同步），体验不统一：面板无标题、非面板工具执行中静默、面板关闭后模型可能丢失完整输出。统一为：**所有工具执行时在对话区产出一个行间区块**（title + 摘要 + 完成标记），替代现有双轨。

### 1.2 功能性需求

| # | 用户故事 |
|---|---|
| FR1 | 每个工具调用产生一个行间区块，含工具名和参数摘要作为 title（如 `❯ write src/x.mjs` / `❯ bash npm test`） |
| FR2 | 区块内显示最多三行执行中内容（实时流或截断），长工具（bash/verify/advisor/subagent）流式追加，短工具（read/edit/write）显示开头三行 |
| FR3 | 工具完成时 title 追加耗时和结果标记（如 `❯ write src/x.mjs — OK (12ms)` / `❯ verify — FAILED (3.2s)`） |
| FR4 | 完整输出不受区块限制——超长结果仍通过落盘机制保留（工具结果 >12k 字符落盘），行间区块只做预览；模型从 history 读取完整结果（现有机制不变） |
| FR5 | 面板机制退出——`outputPanel` 标志逐步废弃，所有工具统一走行间区块（向后兼容：旧工具无 outputPanel 即无面板，新工具不感知此标志） |

### 1.3 非功能性需求

| # | 维度 | 标准 |
|---|---|---|
| NFR1 | 性能 | 区块渲染与现有行间消息同开销（~1ms），流式追加不触发全量重绘 |
| NFR2 | 兼容 | 现有面板逐步降级：保留面板渲染代码直到所有 `outputPanel` 工具迁移，过渡期两种路径共存 |
| NFR3 | 可维护 | 区块渲染为独立函数，所有工具调用走统一入口 |

## 2. 设计（Design）

### 2.1 区块格式

```
❯ toolName argSummary — status (elapsed)
  │ line1
  │ line2
  │ line3
```

- title 行：工具名 + 参数摘要（≤60 字符）+ 执行中状态/完成标记 + 耗时
- 内容行：`  │ ` 前缀 + 内容（最多三行，超出行数截断为 `  │ …`）
- 颜色区分：title 用工具色（write=绿，bash=黄，verify=蓝，error=红），内容用 dim

### 2.2 渲染流程

```
工具开始执行 → dispatch.mjs 在 runOne 前调 callbacks.setupOutputPanel → 
   TUI agent-turn.mjs 创建行间区块实例 → 实时追加内容行 → 工具完成 → 更新 title
```

用 `state.outputPanels` 的现有结构（parts、len、done），但渲染从独立面板区移到对话流中（renderConversation 尾部追加 active 区块）。

### 2.3 过渡期

- `outputPanel: true` 的工具（bash/verify/advisor）先加 title + 行间渲染，面板区保留但逐步缩小（高 0 时自然消失）
- 非面板工具（write/read/grep 等）为第一批迁移目标：执行时在对话区末尾追加行间区块，完成时固定 title
- 最终所有工具统一：无 `outputPanel` 标志区分

### 2.4 受影响文件

| 文件 | 动作 | 用途 |
|---|---|---|
| `src/tui/render-frame.mjs` | MODIFY | 新增 `renderToolBlock`（行间区块渲染）；`renderOutput` 加 title；逐步废弃独立面板渲染 |
| `src/tui/agent-turn.mjs` | MODIFY | 非面板工具的 onToolCall/onToolResult 触发区块创建/更新 |
| `src/tui/layout.mjs` | MODIFY | 面板区高度可收缩至 0（无 active 面板时） |
| `test/tui.test.mjs` | MODIFY | 行间区块渲染测试（title 含工具名+耗时、内容行截断） |

## 3. 测试（Testing）

### 3.1 验收标准

- AC1: 工具执行时对话区出现 `❯ toolName args` title 行
- AC2: 内容行不超过三行，超长尾部显示 `…` 截断
- AC3: 完成时 title 追加耗时和 OK/FAILED 标记
- AC4: 历史中保留完整结果（工具结果落盘/截断机制不变）
- AC5: 面板工具有 title（过渡期），非面板工具不出现空白面板

### 3.2 用例表

| # | 场景 | 输入 | 预期输出 | 映射 |
|---|---|---|---|---|
| T1 | 正常：短工具 | write src/x.mjs (10ms) | title `❯ write src/x.mjs — OK (10ms)`，内容一行 | FR1/FR3 |
| T2 | 边界：长输出截断 | bash 输出 50 行 | title + 内容三行，第四行 `…` | FR2 |
| T3 | 错误：工具失败 | edit 匹配失败 | title `❯ edit src/x.mjs — ERROR (5ms)` | FR3 |
| T4 | 正常：流式工具 | verify 跑测试 | 内容行实时追加，完成后 title 固定 | FR2/FR4 |
| T5 | 边界：超长结果落盘 | write 返回 20k 字符 | 行间三行预览 + history 中保留完整结果 | FR4 |
