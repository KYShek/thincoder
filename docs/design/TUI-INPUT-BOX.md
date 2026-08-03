# TUI 输入框功能规格与回归记录

> 基线：v0.11.1。当前：HEAD（0.12.3+）。
> 本文档记录输入框的完整功能清单、v0.11.1 之后的变更、已确认的回归 bug。
> 目的：防止上下文压缩后丢失输入框行为契约，导致后续修改破坏既有功能。

## 1. 输入框功能清单（v0.11.1 基线）

### 1.1 文本编辑

| 按键 | 行为 |
|------|------|
| 可打印字符 | 插入到光标位置（`state.input` 是字符数组） |
| Backspace | 删除光标前一个字符 |
| Delete | 删除光标处字符 |
| ← / → | 光标左移/右移 |
| Home / End | 光标跳到行首/行尾 |
| Ctrl+U | 清空整个输入框 |
| Enter | 提交（`submit()`） |
| Tab | 斜杠命令补全（`handleTab()`，循环候选） |
| ↑ / ↓ | 输入历史导航（`state.history`） |
| Ctrl+V | 粘贴剪贴板文本（`insertPastedText`，保留换行符用于多行） |
| Ctrl+Alt+V / Alt+V | 粘贴剪贴板图片（写入临时文件，插入 read_image 命令） |
| PgUp / PgDn | 会话区滚动（非输入框） |

### 1.2 字符清洗规则

- 可打印字符插入前：`\r\n` 剥离、`\t` 转两空格
- 粘贴文本：`\r\n` → `\n`、`\r` → `\n`、`\t` → 两空格（保留 `\n` 用于多行输入）
- 输入历史：提交时 `state.input.join("").trim()`，多行文本整体入历史

### 1.3 处理中（`state.processing`）行为

- 可打印字符照常进输入框（排队等当前轮结束）
- Tab / ↑ / ↓ 被屏蔽（不做补全和历史导航）
- Ctrl+D：从队列弹出最后一条
- Ctrl+I 或 Tab：进入中断注入模式（`state.interruptPrompt`）

### 1.4 模式栈（优先级从高到低）

```
permission → question → search(新增) → interruptPrompt → picker → wizard → 正常输入
```

每个模式拦截自己的按键后 `return`，不 fall-through。

### 1.5 渲染

- 输入框由 `layoutInput(chars, cursor, width)` 计算行分割和光标位置
- `renderInputBox` 画边框 + 内容 + 反显光标
- 光标在行尾时：有空位则补空格反显，无空位则反显最后一个字符
- 多行输入（含 `\n`）：`layoutInput` 遇 `\n` 强制换行（`flush()`）
- 输入框最大显示行数 `MAX_INPUT_LINES`，超出部分滚动（`inputOffset`）

## 2. v0.11.1 → HEAD 变更清单

| 提交 | 变更 | 影响 |
|------|------|------|
| `b0bcab4` (0.12.0) | 删除 permission 'a' 的 `_pendingReminders.push(AUTO reminder)` | 模型不再收到"AUTO 已开启"的 history 注入 |
| `79fc3df` | 新增 Ctrl+F 搜索模式；render-loop 重写为 row-diff | 输入框被 search.query 接管；渲染路径全换 |
| `99fecb4` | Shift+Enter 插入 `\n`（多行输入） | 正常，layoutInput 已支持 `\n` |
| `68a0620` | advisor 输出面板、agent.mjs 重构 | 不直接影响输入框 |
| `e1f5bbf` | engineering 门禁 | 不直接影响输入框 |

## 3. 已确认回归 Bug

### BUG-1：搜索模式 'n'/'p' 键被劫持（严重）

**位置**：`key-handler.mjs` 搜索块

```javascript
if (key.name === "n" || (key.ctrl && key.name === "g")) { // Next match
```

`key.name === "n"` 匹配**普通按键 'n'**（无 Ctrl），导致搜索框里无法输入字母 n 和 p——按 n 跳到下一个匹配而不是追加字符。

**修法**：改为 `key.ctrl && key.name === "n"` 或去掉单键触发，只保留 Ctrl+G / Ctrl+R。

### BUG-2：搜索模式无 fall-through 保护（中等）

搜索块末尾没有 `return`。未匹配的按键（↑↓←→、Tab、Home/End、Delete、PgUp/PgDn）会 fall-through 到正常输入逻辑，操作的是不可见的 `state.input` 而不是搜索框。

**修法**：搜索块末尾加 `return`（搜索模式下只处理已列出的键，其余忽略）。

### BUG-3：F1 帮助列出 Ctrl+L 但未实现（轻微）

F1 快捷键帮助显示 "Ctrl+L — Clear screen"，但 key-handler 里没有 Ctrl+L 处理。

**修法**：实现 Ctrl+L 清屏（`state.lines = []; state.scroll = 0; render()`），或从帮助文本删除。

### BUG-4：AUTO reminder 注入被删除（行为变更，低危）

v0.11.1 中权限提示按 'a' 会向 `agent._pendingReminders` 推入 AUTO 开启提醒，模型在下一轮能看到。HEAD 删除了这行，只保留 TUI 侧的 pushLine。模型不再知道 AUTO 被打开了。

**修法**：恢复 `_pendingReminders.push(...)` 一行。

## 4. 输入框状态契约（不可破坏的不变量）

1. `state.input` 是字符数组（`string[]`），`state.cursor` 是整数索引，`0 <= cursor <= input.length`
2. `state.history` 是已提交文本的字符串数组；`historyIndex === -1` 表示不在历史导航中
3. `submit()` 清空 input/cursor、推入 history、重置 historyIndex 和 scroll
4. 模式栈互斥：同一时刻只有一个模式活跃（permission > question > search > interrupt > picker > wizard > normal）
5. `layoutInput` 是纯函数：输入 `(chars, cursor, width)` → 输出 `{ lines, cursorLine, cursorCol }`
6. 粘贴保留 `\n`（多行）；键盘输入剥离 `\r\n`（防 Windows raw mode 泄漏）
7. 处理中（processing）输入排队，Enter 提交进队列而非立即执行（斜杠命令白名单除外）
8. 输入框渲染宽度 = `W - 4`（两侧边框各 1 + 内外边距各 1）

## 5. 修复优先级

| # | Bug | 优先级 | 预计改动 |
|---|-----|--------|---------|
| 1 | 搜索 'n'/'p' 劫持 | P0 | key-handler.mjs 1 行 |
| 2 | 搜索 fall-through | P0 | key-handler.mjs 1 行 |
| 3 | Ctrl+L 未实现 | P2 | 帮助文本删 1 行或加 handler |
| 4 | AUTO reminder 删除 | P1 | key-handler.mjs 恢复 2 行 |
