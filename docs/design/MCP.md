# MCP 工具机制统一规范（CLI / VS Code 一致落地）

> 状态：设计稿 v1（待拍板）
> 目标：**VS Code 向 CLI 对齐**——MCP 工具动态展开为独立原生工具，废弃"网关式"mcp 工具。
> 原则：与 CONTEXT-COMPACTION.md 相同——一套语义，两端一致；正确性/可用性优先于 token 节省。

## 0. 现状与问题

| | CLI（thincoder） | VS Code（thincoder-vscode） |
|---|---|---|
| 机制 | **动态展开**：`connectMcpServer` 把每个 MCP 工具包装成独立工具（`{server}_{tool}` 前缀、完整 inputSchema、execute→tools/call），并入 `agent.tools` → toolSchemas | **静态网关**：单一 `mcp` 工具，模型手动 `connect → list → call` 三层路由 |
| 连接时机 | 启动装配（make-agent 批量连接 `config.mcp.servers`）+ 运行时 `/mcp connect/remove/reconnect` 热插拔 | 模型经 mcp 工具运行时 connect；registry（`src/mcp/index.mjs` `_servers`）模块级存活 |
| 失败语义 | 连接失败不阻塞：warning 记录，下一条 user 消息后注入提醒 | 连接失败返回错误字符串给模型 |
| 子代理 | `tools = parent.tools`——展开工具天然继承（coder 子代理可用）；explore/plan 只读过滤滤掉 | 网关工具在 builtinTools——子代理都可见但需手动路由 |
| 模型体验 | 与内置工具无差别：完整 schema、可并行、直接调用 | 多轮往返、参数手拼、无法并行、serverId 状态易错 |

**问题**：VS Code 网关式是旧设计（省 token 的考量），体验与能力都劣于 CLI 展开式；两端行为不一致。

## 1. 统一设计（对齐 CLI）

### D1 工具展开（两端一致）

`mcpConnect(config)` 成功后，把服务器 `tools/list` 返回的每个工具包装为：

```js
{
  name: sanitizeToolName(`${config.name}_${t.name}`),  // 前缀防冲突；无 name 时 "mcp_"
  description: t.description ?? `MCP tool: ${t.name}`,
  parameters: t.inputSchema ?? { type: "object", properties: {} },
  readonly: false,
  async execute(args) {
    const resp = await transport.send("tools/call", { name: t.name, arguments: args })
    if (resp.error) throw new Error(`MCP tool "${t.name}": ${resp.error.message}`)
    return content 按 text/resource/其他 序列化，join "\n"（与 CLI 完全一致）
  },
  _mcpTransport: transport, _mcpName: config.name,
}
```

- 命名/序列化/错误格式与 CLI `src/mcp.mjs buildTools` **逐字节同款**
- 工具名前缀：`{server}_{tool}`；无 name 用 `mcp_`；`sanitizeToolName` 清理非法字符

### D2 连接时机（VS Code 对齐 CLI 装配语义）

- **顶层 runAgent 装配时连接**：`opts.mcpServers`（已传入）→ 对每个未连接的 server **幂等连接**（registry 按 `config.name`/端点键控，已连跳过）→ 成功展开工具并入本轮 toolSchemas；失败不阻塞（记 warning → 注入提醒，与 CLI 一致）
- **每轮重新装配**：VS Code runAgent 每次调用重建 tools 数组——registry 状态变化（面板重连/断开）天然在下一轮生效（热插拔）
- **面板管理**：连接/断开/重连仍由 MCP 状态面板驱动（UI 已存在）；模型不再管理连接

### D3 废弃 mcp 网关工具

- `mcpTool`（connect/list/call/disconnect 四动作）**从 builtinTools 移除**
- `mcpListTools/mcpCallTool/mcpDisconnect` 保留为内部 API（面板/工具展开使用）
- 连接状态展示（面板 MCP 状态段）不变

### D4 子代理继承

- coder/默认子代理：工具继承父 agent 全部工具（含 MCP 展开工具）——与 CLI `parent.tools` 语义一致
- explore/plan：只读过滤自然滤掉 MCP 工具（readonly: false）✓ 无需额外处理
- 子代理上下文注入的 "[System: configured MCP servers (use mcp tool to connect)]" 提醒**改为不含 mcp 工具指引**——展开后无需指引；改为列出已连接的工具数（可选，避免误导）

### D5 关闭与生命周期

- `closeAllMcp()` 退出时关闭全部 transport（已有，保持）
- 面板"删除服务器"：关闭 transport + 从 registry 移除 → 下一轮工具表不再含其工具（CLI `/mcp remove` 同语义：`removeMcpTools` 从 agent.tools 移除 + 关闭）

### D6 失败与错误

- 连接失败：warning（面板显示 + 下轮提醒注入），不阻塞对话（CLI 同款）
- 工具调用失败：execute 抛错 → dispatch 捕获 → 模型见 `Error: …`（与内置工具一致）

## 2. 落地清单

### thincoder-vscode

| # | 改动 | 位置 |
|---|---|---|
| V1 | `mcp/index.mjs` 新增 `buildMcpTools(client)`（展开包装，CLI buildTools 同款）；`mcpConnect` 返回展开工具 | `src/mcp/index.mjs` |
| V2 | runAgent 装配：`opts.mcpServers` → 幂等连接 → 展开工具并入 `tools`；连接失败 warning 注入 | `src/agent.mjs` |
| V3 | `mcpTool` 从 `builtinTools` 移除 | `src/tools/index.mjs` + `src/mcp/index.mjs` |
| V4 | MCP 提醒文本更新（不再指引 mcp 工具） | `src/agent.mjs`（155-161 行） |
| V5 | 测试：展开工具命名/schema/执行路由；失败不阻塞 | `test/` |
| V6 | 文档：`docs/design/ARCHITECTURE.md` MCP 段引用本文档 | — |

### thincoder（CLI）

无需改动——CLI 现状即目标（仅验证 `buildTools` 与 V1 同款）。

## 3. 验收口径

1. 两端 MCP 工具展开后：命名 `{server}_{tool}`、schema 完整、execute 直调——**行为一致**
2. VS Code 模型无需 mcp 工具即可直接调用任何已连接服务器的工具（schema 完整、可并行）
3. 面板连接/断开在下一轮生效（热插拔）；失败不阻塞对话
4. 子代理：coder 继承 MCP 工具；explore/plan 不可见
5. 旧 `mcp` 网关工具彻底移除，无残留引用
