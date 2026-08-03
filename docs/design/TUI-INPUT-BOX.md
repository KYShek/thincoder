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
| **Shift+Enter** | **插入换行（多行输入）** — 需终端键盘增强协议（见 1.5）；不支持时退化为提交 |
| Alt+Enter（`meta+return`） | 插入换行（后备多行键，所有终端可用） |
| Tab | 斜杠命令补全循环 |
| ↑ ↓ | 输入历史导航（见 1.3） |
| Ctrl+V | 粘贴剪贴板文本（保留 `\n`，支持多行粘贴） |
| Alt+V / Ctrl+Alt+V | 粘贴剪贴板图片 → 插入 `read_image <path>` 命令 |
| Ctrl+F | 进入搜索模式 |
| Ctrl+I / Tab(处理中) | 中断注入模式 |
| PgUp/PgDn | 会话区滚动 |

### 1.3 历史导航语义（FIX-5 已实现草稿保护）

- ↑：`historyIndex` 回退，加载历史条目；**首次进入导航前，未提交的输入存入 `state._draft`**
- ↓：`historyIndex` 前进；走到头时**从 `_draft` 恢复原来在打的字**（无草稿则回空白），恢复后清 `_draft`
- 空输入进入导航不存草稿；`submit()` 清 `_draft`
- 处理中（`processing`）：↑↓ 被屏蔽，输入排队进 `state.queue`

### 1.4 多行输入的真实能力（实测结论）

| 途径 | 状态 | 说明 |
|------|------|------|
| **粘贴多行文本** | ✅ 正常 | bracketed paste → `insertPastedText` 保留 `\n`；v0.11.1 就如此 |
| **Shift+Enter 插换行** | ✅ 修复后正常 | 见下方协议方案 |
| Alt+Enter 插换行 | ✅ 保留 | 作为不支持键盘协议终端的后备路径（readline 对 `\x1b\r` 稳定解析为 `name:"return", meta:true`） |

### 1.5 Shift+Enter 的实现方案（用户要求 Shift+Enter，2026-08-03 拍板）

**问题**：多数终端默认对 Shift+Enter 发送裸 `\r`，与 Enter 字节级不可区分——监听 `key.shift` 是死路（`99fecb4` 的错误）。

**方案：键盘增强协议（kitty keyboard protocol / CSI-u）**
1. 启动时向终端发送 `\x1b[>1u`（push keyboard mode：disambiguate + report event types）。支持的终端（Windows Terminal 1.18+、VS Code 终端、kitty、iTerm2、alacritty）从此对修饰键组合发 CSI-u 序列；不支持的终端忽略该序列，行为不变（裸 `\r` 仍正常提交）
2. Shift+Enter 在 CSI-u 下是 `\x1b[13;2u`。stdin 数据层（bracketed paste 解析之后）把 `\x1b[13;2u` 与 modifyOtherKeys 变体 `\x1b[27;2;13~` 翻译为 `\x1b\r`
3. `\x1b\r` 进 readline → 稳定解析为 `name:"return", meta:true` → 命中 key-handler 的 Alt+Enter 分支插 `\n`
4. 退出时发送 `\x1b[<u`（pop keyboard mode）恢复终端默认

**为什么走 stdin 翻译而不是在 key-handler 里处理 CSI-u**：Node readline 不认识 CSI-u 序列（实测解析为 `name:"undefined"` 或拆成垃圾字符），必须在进 readline 之前拦截。翻译层与 bracketed paste、鼠标序列剥离同层（index.mjs 的 stdin data handler）。

**后备**：终端不支持协议时 Shift+Enter 退化为普通 Enter（提交）；用户可用 Alt+Enter 换行。

## 2. v0.11.1 → HEAD 变更与回归审计

| 提交 | 变更 | 判定 |
|------|------|------|
| `b0bcab4` | 删除权限 'a' 的 AUTO reminder 注入 | **回归 BUG-4** |
| `79fc3df` | Ctrl+F 搜索 + render-loop 重写 row-diff | **回归 BUG-1/2/3** |
| `99fecb4` | Shift+Enter 多行 | **回归 BUG-5**（实测不可用，还会污染输入） |
| `68a0620` / `e1f5bbf` | advisor 输出面板 / engineering 门禁 | 不影响输入框 |

## 3. 已确认回归与修复方案（逐项，已全部修复 @ post-aac53d9）

### BUG-1（P0）搜索框打不出字母 n/p — **已修**
`key-handler.mjs` 搜索块：`key.name === "n"` 匹配普通按键（缺 `key.ctrl`），按 n 变成"下一个匹配"。
**修法**：导航改为 `key.ctrl && name === "n"/"p"`（Ctrl+G/Ctrl+R 兼容保留）；裸 n/p 作为 query 字符输入。

### BUG-2（P0）搜索模式按键穿透 — **已修**
搜索块末尾无兜底 `return`，↑↓←→/Tab/Delete/PgUp 等穿透到隐藏的 `state.input`。
**修法**：搜索块末尾加兜底 `return`（含 Esc 与 Ctrl+C 退出分支）。

### BUG-3（P2）F1 帮助写了 Ctrl+L 清屏但未实现 — **已修**
**修法**：F1 帮助删掉 Ctrl+L 一行，替换为 "Alt+Enter — Insert newline"（不新增快捷键，避免与终端自身 Ctrl+L 冲突）。

### BUG-4（P1）权限按 'a' 开 AUTO 后模型收不到提醒 — **已修**
`b0bcab4` 删了 `agent._pendingReminders.push(...)`。
**修法**：恢复 v0.11.1 的 2 行注入。测试断言 `_pendingReminders` 含 AUTO reminder。

### BUG-5（P0）Shift+Enter 多行不可用且污染输入 — **已修（Shift+Enter 恢复可用）**
`99fecb4` 的 `if (key.shift)` 分支在真实终端不触发或触发垃圾字符（见 §1.4/§1.5 实测）。
**修法**：删除 key-handler 里的 Shift 分支（死代码），改为 §1.5 的键盘协议方案：stdin 层启用 CSI-u 并把 Shift+Enter 序列翻译为 `\x1b\r`，命中 meta+return 分支插换行。不支持协议的终端退化：Shift+Enter = 普通提交，Alt+Enter 仍可换行。F1 帮助与输入框边框提示显示 "Shift+Enter newline"。

## 4. 新增需求（用户报告"↓ 回不到当前输入"）

### FIX-5（P1）历史导航草稿保护 — **已实现**
现状：正在打字时按 ↑，草稿被覆盖且无法找回。
**实现**（对齐常见 shell 行为）：
- 进入历史导航前（`historyIndex === -1` 且 `input.length > 0` 时首次按 ↑），当前 input 存入 `state._draft`
- ↓ 走到头时从 `_draft` 恢复（不再清空为空白），恢复后清 `_draft`
- 空输入进入历史不存草稿（↓ 到头仍回空白）
- `submit()` 时清除 `_draft`
- 改动：key-handler.mjs up/down 分支、index.mjs state 初始化 `_draft: null` + submit 清除

## 5. 测试要求（修复必须带测试，test/tui.test.mjs）

1. 搜索模式：输入 `n`/`p` 追加进 query（不触发导航）；未列出的键不改动 state.input
2. Alt+Enter（`key.meta` + return）插入 `\n`；普通 return 提交
3. 权限 'a'：`agent._pendingReminders` 含 AUTO reminder
4. 草稿保护：打字 → ↑ → ↓ 到头 → input 恢复为原草稿
5. translateShiftEnter：CSI-u `\x1b[13;2u` / modifyOtherKeys `\x1b[27;2;13~` → `\x1b\r`；裸 `\r` 与 Alt+Enter CSI-u（modifier≠2）不动
6. 全量 `npm test` 过（当前基线 369）

## 6. 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/tui/key-handler.mjs` | BUG-1/2/4/5 修复 + FIX-5 草稿保护 + meta+return 多行分支 |
| `src/tui/index.mjs` | state 加 `_draft: null`；stdin 层 translateShiftEnter 接线；启动 keyboardPush / 退出 keyboardPop |
| `src/tui/ansi.mjs` | keyboardPush / keyboardPop 序列常量 |
| `src/tui/clipboard.mjs` | translateShiftEnter（CSI-u / modifyOtherKeys → `\x1b\r`） |
| `src/tui/render-frame.mjs` | 输入框边框提示 "Shift+Enter newline" |
| `test/tui.test.mjs` | §5 的测试 + translateShiftEnter/多行键测试 |
