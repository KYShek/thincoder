# TUI 输入框功能规格、回归记录与修复方案

> **本文档是输入框的唯一行为契约。任何对输入框/键处理的修改，先读这里，改完更新这里。**
> 基线：v0.11.1。当前 HEAD：0.12.3+。

## 1. 输入框功能契约（当前应有的完整行为）

### 1.1 状态模型（不可破坏的不变量）

1. `state.input` 是字符数组（`string[]`）；`state.cursor` 是整数，恒满足 `0 <= cursor <= input.length`
2. `state.history` 是已提交文本的字符串数组；`historyIndex === -1` 表示不在历史导航中
3. `submit()`：清空 input/cursor → `history.push(text)` → `historyIndex = -1` → `scroll = 0`
4. 模式栈互斥，优先级从高到低：`permission → question → search → interruptPrompt → picker → wizard → 正常输入`。每个模式处理自己的键后必须 `return`
5. `layoutInput(chars, cursor, width)` 是纯函数：`(chars, cursor, width) → { lines, cursorLine, cursorCol }`，遇 `\n` 强制换行
6. 输入框渲染宽度 = `W - 4`；最多显示 `MAX_INPUT_LINES`（5）行，超出滚动（`inputOffset`）
7. 渲染层是 `renderRows`（row-diff）：每帧全量计算屏幕行 → 与上一帧 diff → 只重写变化行。输入框内容变化靠"行内容不同则重写"，无独立缓存

### 1.2 按键表（正常输入模式）

| 按键 | 行为 |
|------|------|
| 可打印字符 | 插入光标位置（`\r\n` 剥离、`\t` → 两空格） |
| Backspace / Delete | 删光标前/处字符 |
| ← → Home End | 光标移动 |
| Ctrl+U | 清空输入框 |
| Enter（`return`/`\r`） | 提交 |
| **Alt+Enter（`meta+return`）** | **插入换行（多行输入）** ← 修复后的唯一多行键 |
| Tab | 斜杠命令补全循环 |
| ↑ ↓ | 输入历史导航（见 1.3） |
| Ctrl+V | 粘贴剪贴板文本（保留 `\n`，支持多行粘贴） |
| Alt+V / Ctrl+Alt+V | 粘贴剪贴板图片 → 插入 `read_image <path>` 命令 |
| Ctrl+F | 进入搜索模式 |
| Ctrl+I / Tab(处理中) | 中断注入模式 |
| PgUp/PgDn | 会话区滚动 |

### 1.3 历史导航的真实语义（用户须知，两版一致，从未改变）

- ↑：`historyIndex` 回退，**当前未提交的输入被历史条目直接覆盖**（无草稿保护）
- ↓：`historyIndex` 前进；走到头（超出最后一条）时 `input = []` 回到空白
- **不存在"↓ 恢复我刚才正在打的草稿"这一功能**——草稿在按 ↑ 的瞬间就被覆盖丢失了。若需要此功能，属于新增需求（见 §4 FIX-5），不是回归
- 处理中（`processing`）：↑↓ 被屏蔽，输入排队进 `state.queue`

### 1.4 多行输入的真实能力（实测结论）

| 途径 | 状态 | 说明 |
|------|------|------|
| **粘贴多行文本** | ✅ 正常 | bracketed paste → `insertPastedText` 保留 `\n`；v0.11.1 就如此 |
| **Alt+Enter 插换行** | ✅ 修复后正常 | readline 对 `\x1b\r` 稳定解析为 `name:"return", meta:true` |
| Shift+Enter | ❌ 不可靠，已废弃 | 多数终端发 `\r`（与 Enter 不可区分）；CSI-u 序列 readline 不认；modifyOtherKeys 序列被拆成 `1`/`3`/`~` 垃圾字符 |

## 2. v0.11.1 → HEAD 变更与回归审计

| 提交 | 变更 | 判定 |
|------|------|------|
| `b0bcab4` | 删除权限 'a' 的 AUTO reminder 注入 | **回归 BUG-4** |
| `79fc3df` | Ctrl+F 搜索 + render-loop 重写 row-diff | **回归 BUG-1/2/3** |
| `99fecb4` | Shift+Enter 多行 | **回归 BUG-5**（实测不可用，还会污染输入） |
| `68a0620` / `e1f5bbf` | advisor 输出面板 / engineering 门禁 | 不影响输入框 |

## 3. 已确认回归与修复方案（逐项）

### BUG-1（P0）搜索框打不出字母 n/p
`key-handler.mjs` 搜索块：`key.name === "n"` 匹配普通按键（缺 `key.ctrl`），按 n 变成"下一个匹配"。
**修**：改为 `(key.ctrl && key.name === "n")` / `(key.ctrl && key.name === "p")`，或直接只留 Ctrl+G/Ctrl+R 并允许裸 n/p 输入。

### BUG-2（P0）搜索模式按键穿透
搜索块末尾无兜底 `return`，↑↓←→/Tab/Delete/PgUp 等穿透到隐藏的 `state.input`。
**修**：搜索块末尾加 `return`。

### BUG-3（P2）F1 帮助写了 Ctrl+L 清屏但未实现
`/clear` 命令存在但无 Ctrl+L 快捷键。
**修**：F1 帮助文本删掉 Ctrl+L 一行（不新增快捷键，避免与终端自身 Ctrl+L 冲突）。

### BUG-4（P1）权限按 'a' 开 AUTO 后模型收不到提醒
`b0bcab4` 删了 `agent._pendingReminders.push("[System reminder: AUTO mode is now ON...]")`，只留 TUI pushLine。
**修**：恢复这 2 行（v0.11.1 原样）。

### BUG-5（P0）Shift+Enter 多行不可用且污染输入
`99fecb4` 的 `if (key.shift)` 分支在真实终端不触发或触发垃圾字符（见 §1.4 实测）。
**修**：删除 `key.shift` 分支；Enter 处理改为：`key.meta`（Alt+Enter）→ 插 `\n`，否则提交。同步更新 F1 帮助与输入框边框提示。

## 4. 新增需求（用户报告"↓ 回不到当前输入"）

### FIX-5（P1）历史导航草稿保护
现状：正在打字时按 ↑，草稿被覆盖且无法找回。
**方案**（对齐常见 shell 行为）：
- 进入历史导航前（`historyIndex === -1` 且 `input.length > 0` 时首次按 ↑），把当前 input 存入 `state._draft`
- ↓ 走到头（`historyIndex` 超出）时，从 `_draft` 恢复输入而非清空
- 提交或 Esc 时清除 `_draft`
- 改动点：key-handler.mjs 的 up/down 两个分支 + state 初始化加 `_draft: null`

## 5. 测试要求（修复必须带测试，test/tui.test.mjs）

1. 搜索模式：输入 `n`/`p` 追加进 query（不触发导航）；未列出的键不改动 state.input
2. Alt+Enter（`key.meta` + return）插入 `\n`；普通 return 提交
3. 权限 'a'：`agent._pendingReminders` 含 AUTO reminder
4. 草稿保护：打字 → ↑ → ↓ 到头 → input 恢复为原草稿
5. 全量 `npm test` 过（当前基线 360）

## 6. 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/tui/key-handler.mjs` | BUG-1/2/4/5 修复 + FIX-5 草稿保护 |
| `src/tui/index.mjs` | state 加 `_draft: null` |
| `src/tui/render-frame.mjs` | 输入框边框提示加 "Alt+Enter 换行" |
| `test/tui.test.mjs` | §5 的 4 组测试 |
