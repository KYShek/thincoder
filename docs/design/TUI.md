# TUI 设计（thincoder/src/tui/）

> 状态：2026-08 回补。零依赖裸 ANSI 终端界面——不用 ink/React，不用 termbox，直接对 raw-mode stdin 和 ANSI 转义序列编程。
> 设计原则：**纯函数可测**（渲染/布局全部抽成无副作用的纯函数，`test/tui.test.mjs` 直接单测）；**分层**（stdin 解码 / 状态 / 渲染 / 交互 / 命令各自独立模块）。

## 1. 模块地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.mjs` | 433 | startTUI 入口：raw mode、stdin 分块解码、状态对象、cleanup、paste 协议、Shift+Enter 翻译 |
| `key-handler.mjs` | ~530 | 按键分发：permission/question/search/picker/wizard/interruptPrompt/输入编辑 |
| `render-frame.mjs` | ~310 | 帧布局：header / todo / conversation / input / status 各面板装配 |
| `render-conversation.mjs` | ~130 | 对话面板行构建：缓存、搜索高亮、markdown 表格、折叠 |
| `render.mjs` | 213 | 纯函数：字符宽度（CJK/emoji）、wrap、slice、markdown 表格对齐、sanitize |
| `markdown.mjs` | ~60 | 轻量行内 markdown → ANSI（粗体/下划线/删除线/标题） |
| `render-loop.mjs` | 112 | 渲染调度：增量重绘、1s ticker、光标/滚动维护 |
| `layout.mjs` | 134 | 面板布局计算（行/列分配，含 todo 面板与子代理面板） |
| `agent-turn.mjs` | ~500 | runAgentTurn：回合驱动、callbacks 构造、ContinueError 续跑、队列 |
| `startup.mjs` | 116 | 启动屏 + 会话恢复渲染 + 后台索引 |
| `interaction.mjs` | 82 | 权限确认（y/n/a）、自由提问（question 工具） |
| `pickers.mjs` | 394 | 通用列表选择器（filter/滚动/栈）+ 模型两级选择器 + /provider 流程 |
| `slash-commands.mjs` | 165 | /命令表、别名、补全、Tab 循环 |
| `wizard.mjs` | 172 | 首启配置向导（provider → key → embedding → model） |
| `clipboard.mjs` | 96 | 剪贴板文本/图像读取（Win powershell / macOS pbpaste） |
| `config-helpers.mjs` | ~60 | persistRaw / syncProviderField / maskKey |

## 2. stdin 输入层（index.mjs）

- `emitKeypressEvents(keyStream)`（node:readline）把原始字节转成 keypress 事件；`keyStream` 是 `process.stdin` 的 PassThrough 副本——**paste 多块数据先写入 keyStream 再交给 readline 解析**，保证按键与粘贴按序到达。
- **分块解码**：`utf8Decoder.decode(chunk, { stream: true })`——CJK 字符跨 chunk 边界时正确拼装（有专门测试）。鼠标序列可能跨 chunk 截断：`mousePending` 保存不完整尾部，下个 chunk 拼接。
- **鼠标滚轮**：SGR 序列 `\x1b[<64;…M`（上 3 行）/`<65`（下 3 行），处理后剥离。
- **鼠标点击**（`mouse.mjs`）：左键按下 `\x1b[<0;col;rowM` → picker 选项点击选中（跳过标题行，按 `_row` 映射 filteredItems）；对话区点击带 `_foldToggle` 的行**折叠/收起切换**（`expandedBlocks` toggle）。消息行点击无动作——行菜单已移除（终端拖选复制是原生能力，菜单是多余中间层）。坐标 1-based、col 在前；release/滚轮不消费。点击映射与渲染共用同一套布局数学（`convGlobalIndex` 与 renderConversation 同式）。
- **粘贴协议**（bracketed paste）：`\x1b[200~` 进入 pasteMode，`\x1b[201~` 退出；跨多 chunk 的粘贴先写前缀 + 进入 paste 模式累积，退出时一次性写入。粘贴文本**跳过按键分发**直接进输入缓冲（`insertPastedText`）。
- **Shift+Enter**（多行输入第一协议，键盘增强终端）：stdin 层 `translateShiftEnter` 把 CSI-u 的 Shift+Enter 序列翻译为 `\x1b\r`（meta+return）→ key-handler 的 `key.alt && key.name === "return"` 分支插入 `\n`。Ctrl+J（`\n` 字节）是第二协议（全终端兜底）；Alt+Enter 是后备（旧控制台可能被系统截走）。
- **state 对象**（渲染全部数据源）：lines / streaming / reasoning / advisorStreaming / input（codepoint 数组）/ cursor / history / scroll / processing / controller / permission / question / picker + pickerStack / wizard / tasks / tokens / search / expandedBlocks / foldEnabled / **exitArmed（Ctrl+C 双确认，IK61BI）** 等。
- **cleanup**（退出路径统一）：saveSession 同步写盘 → closeAllMcp → 终端复位（清屏、mouse/paste/keyboard/modifyOtherKeys off、主缓冲区、显示光标）。`process.on("exit", cleanup)` 注册一次；`/exit` 与 Ctrl+C 最终都走 `process.exit`。

## 3. 按键分发（key-handler.mjs）

**状态优先级**（从高到低，每个状态独占处理并 return）：

```
permission（y/n/a/esc）
  → question（选项 ↑↓/enter/esc，自由文本）
  → search 模式（Ctrl+F 进入：Ctrl+N/P/G/R 导航、esc 退出、字符输入过滤）
  → picker 栈 / wizard（↑↓ 选择、enter 确认、esc 取消）
  → interruptPrompt（Ctrl+I 后输入注入消息）
  → 正常输入编辑（字符/退格/Ctrl+U/Ctrl+V/↑↓历史/多行）
```

**Ctrl+C 三态**（IK61BI）：
1. picker 打开 → 取消当前 picker（等同 Esc），不杀进程
2. processing 且有 controller → `abort()` + "[Aborting…]" 提示，不退出
3. 空闲态 → **双确认**：第一次只提示"Press Ctrl+C again within 3s to exit"并置 `exitArmed`（超时自动解除，可注入 `exitArmDelay`）；窗口内再按才走 cleanup + 延迟退出（`exitTimer`，测试注入大延迟防真退出）

**Ctrl+I 中断注入**：processing 时进入 interruptPrompt 状态，输入消息 Enter 提交 → `controller.abort({ interrupt: true, message })` → agent 循环把 `[User interrupt: …]` 注入历史后重开 controller 续跑（见 AGENT-LOOP.md §中断语义）。

**F1 帮助**、`/` 命令补全提示（status bar live hints）由 slash-commands 提供。

## 4. 渲染管线

**帧装配**（render-frame.mjs `renderFrame`）：
```
header（logo/模型/think 徽章/目录）
todo 面板（task 列表，≤5 行，全部 done 自动收起）
对话面板（renderConversation）
输入框（layoutInput：多行展开、光标定位、粘贴快捷键提示角标）
状态栏（status：模式/耗时/token/上下文利用率/队列/快捷键提示）
```
布局分配见 `layout.mjs computeLayout`（面板高度随内容伸缩，子代理面板 ≤4 行）。

**对话行构建**（render-conversation.mjs，纯函数）：
```
原始 text
  → highlightSearchMatches（搜索命中：当前项反白、其余黄下划线）
  → sanitizeDisplay（剥 ANSI/控制字符，防网格污染）
  → formatTables（markdown 表格按显示宽度重排，CJK 对齐）
  → wrapText（按 stringWidth 换行，宽度 = cols-1）
  → renderMarkdownHeading + renderMarkdownInline（**粗体**/`下划线代码`/~~删除线~~/标题，IK5VW3）
  → 折叠（连续 dim 行 >8 折成 "… N more lines — click to expand"）
```
关键约束：**markdown ANSI 在 wrap 之后插入**——插入的转义序列不再参与宽度计算，不破坏对齐。窄作用域复位（`22`/`24`/`29` 而非 `0`）保证不冲掉行底色。缓存：`convCacheKey`（lines 长度/最后一行长度/streaming/reasoning 长度 + expandedBlocks 摘要）命中则跳过重建。

## 4. 折叠交互（双向：展开 ↔ 收起）

**折叠对象**（要求 `foldEnabled !== false` 且 key 不在 `expandedBlocks`）：
1. **长消息折叠**：**任意**单条消息（主输出 C.text、思考 C.reason、工具摘要 C.dim——凡是 wrap 后 >12 行的都算）→ 折叠为 `[首行, hint, 末行]`；key = `long-{lines 索引}`（稳定，跨重渲染）。**主输出/思考是折叠的主力对象**——它们才是实际内容最长的；dim 工具摘要反而很少触发。双向折叠保证阅读可控：点击展开看全文，看完点收起提示收回去
2. **连续 dim 块折叠**：连续 dim 行 >8 → 折叠为 `[首行, 次行, hint]`；key = `fold-{n}`

**标志（哪里可折叠一眼可见）**：
- **折叠态**：块**头部**提示行 `  ▶ … N more lines — click to expand`（bold cyan + `▶` 图标 + "click to expand" 下划线）——头部即点击点，含义清晰
- **展开态**：**同一位置**（块头部、内容之前）换成 `  ▼ … N lines — click to collapse`（bold cyan + `▼` 图标 + "click to collapse" 下划线）——收起标志贴着内容开头，不沉到尾部

**动作（点击即切换）**：点击任意带 `_foldToggle` 的行（头部 ▶/▼ 提示）→ `expandedBlocks` **toggle**（有则删=收起、无则加=展开）→ 重渲染。折叠/收起标志**始终在块头部同一位置**——状态切换点稳定，`▶`/`▼` + 下划线文案给出"可点击"的视觉暗示。

**约束**：
- 展开的长 dim 块行带 `_skipDimFold` 标记，不再参与连续 dim 折叠（防折叠套折叠——0.12.7 回归修复）
- **历史上"主输出/思考永不折叠"的约束已撤销**（0.12.7 的临时修复）：当时只有单向折叠，折叠=内容被锁住影响阅读；双向折叠落地后重新纳入——>12 行的主输出/思考默认折叠为 3 行（首末行可见），点击展开/收起
- `/fold off` 时两类折叠与全部提示行不出现；`/fold on` 恢复
- 展开态与折叠态切换由 `convCacheKey` 的 expandedBlocks 摘要驱动缓存失效

**渲染调度**（render-loop.mjs）：`scheduleRender()`（setImmediate 合并）+ 处理中 1s ticker（耗时刷新）+ `write()` 增量写（比较上一帧，只重绘变化行 + 光标定位），防闪烁。

**宽度数学**（render.mjs）：charWidth——CJK/emoji/全角 2 列、组合字符/零宽 0、其余 1；wrap/slice/pad 全部按显示宽度而非字符数。

## 5. 会话恢复（startup.mjs）

优先级：`display` 快照（WYSIWYG，恢复原样）> `history` 重建（user/assistant 逐条渲染，工具结果只显示首行摘要）。**恢复渲染过滤 `[System reminder:` 前缀的机读消息**（人读线本来就不含，过滤是纵深防御）；markdown 表格/行内渲染同样生效。恢复后提示 `/new` 开新会话；多槽位提示 `/session`。

## 6. 回合驱动（agent-turn.mjs）

`runAgentTurn(ctx, text)`：
1. pushLabel "❯ You:" + 输入文本
2. 置 processing、新建 AbortController、1s ticker
3. callbacks 构造（onToken/onReasoning 流式进 streaming/reasoning 缓冲；子代理 `role#id/` 前缀分流到 subTasks 面板；onToolCall/onToolResult 工具摘要行；onUsage 累计 token；onCompress 提示 "[context] Context too long, auto-compacted"）
4. runAgent 循环：正常完成 → flushStream；AbortError（Ctrl+I）→ 重开 controller 续跑；ContinueError → permission 询问 "Continue after N turns?"；其他错误 → "[error] …" 一行
5. finally：停 ticker、清 processing、**自动生成会话标题**（首条真实 user 消息 → generateTitle）、saveSession 增量落盘
6. 队列：processing 期间输入的消息进 `state.queue`，回合结束自动逐条处理（斜杠命令直接执行）

## 7. 交互层与命令层

- **interaction.mjs**：`askPermission(name, args)`（y/n/a；a = 批准并开启 AUTO）、`askQuestion(text, options)`（选项列表 ↑↓ 或自由文本）——agent 工具（permission/question）与 TUI 的桥。
- **slash-commands.mjs**：`SLASH_COMMANDS` 表 + `SLASH_ALIASES`（/h /x /m /p /t /c /n）+ `HANDLERS` 分派；`completions(input)` 按命令/参数补全；Tab 循环候选。命令分两类：**即时反馈**（/plan /auto /fold 等本地状态切换）与 **菜单循环**（/config /think /mcp /provider 等 picker 驱动）。
- **wizard.mjs**：首启无 key 时进入——provider 选择（含自定义端点）→ API key → embedding key（可跳过）→ 模型；Esc 可随时跳过。
- **pickers.mjs**：通用选择器（标题/条目/filter 输入/位置指示/↑ more ↓ more/栈式嵌套）；模型选择器两级（provider → model，可 fetch `/models` 拉取真实列表，失败回退预设）；`/provider` 添加/删除/设 key 的问答流程。

## 8. 关键设计决策

| 决策 | 理由 |
|---|---|
| 纯函数渲染 | 无终端也能全量单测（tui.test.mjs 1147 行） |
| stdin 双层（keyStream + paste 累积） | 粘贴与按键保序，bracketed paste 大文本不丢 |
| Ctrl+C 永不直接杀进程 | 防误触（双确认）+ picker/生成语义分层（IK61BI） |
| markdown 渲染放 wrap 后 | ANSI 不干扰宽度数学；窄复位不清行色（IK5VW3） |
| 恢复优先 display 快照 | WYSIWYG 保真；history 重建是降级路径 |
| 恢复过滤 [System reminder: | 机读消息不显示（与 VS Code 渲染契约一致） |
| 增量渲染 + 缓存键 | 1M 行会话不卡：只重绘变化行 |
| 子代理流 `role#id/` 前缀 | 主/子流共用一套回调，按前缀分流到子任务面板 |
