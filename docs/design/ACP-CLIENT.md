# ACP Client Protocol 接入 — thincoder acp 设计

> 状态：2026-08-04 设计初稿（待确认后编码）。
> 目标：`thincoder acp` 子命令——通过 [Agent Client Protocol](https://agentclientprotocol.com/)
> 在 stdio 上暴露 thincoder agent，使 Zed / JetBrains AI Chat / Paseo 等 ACP 客户端可直接驱动。
> 实证来源：① **协议权威**——`agentclientprotocol/agent-client-protocol` 仓库 `schema/v1/schema.json`
> （稳定协议版本 **1**；方法名/事件类型以 schema 为准）；② kimi-code `packages/acp-adapter/`
> 实现矩阵与 docs（参考实现，其方法名与 schema v1 一致）；③ Zed 配置（kimi docs 实证）。
> **注意**：`@agentclientprotocol/sdk@0.23.0` 是 SDK 包版本，不是协议版本；kimi 文档中的
> "stable 10/12" 按其 SDK 表面统计，本设计以 schema v1 方法清单为准。

## 1. 背景与目标

竞争评估（COMPETITIVE-CLI-2026.md）P0 项。thincoder 已有专有 VS Code 扩展；ACP 一次实现，
Zed / JetBrains / Paseo（桌面+Web+移动自托管编排器）全通——补上"编辑器接线"生态位。

**具体收益**：
- 编辑器上下文自动注入（打开文件/光标/选区，无需手动 @）
- agent 编辑以 IDE 原生 diff 应用（fs 反向 RPC）
- 工具审批弹在 IDE 内（request_permission）
- 登录态/会话复用（一次终端登录，多表面可用）

## 2. 协议基础（ACP schema v1）

- 传输：**NDJSON over stdio**（每行一个 JSON，JSON-RPC 2.0）
- 方向：IDE = client（发起请求）、agent = server（响应 + 反向 RPC 通知）
- 版本：`initialize` 内 `protocolVersion` 协商（当前稳定版本 `1`）
- 方法清单（schema v1 提取）：agent 侧 `authenticate / initialize / logout / session/{new,load,resume,list,delete,prompt,cancel,close,set_mode,set_config_option}`；client 侧 `fs/{read,write}_text_file / session/{update,request_permission} / terminal/{create,output,release,kill,wait_for_exit}`（terminal 为 client→agent 请求，agent 可实现可不实现）

## 3. 方法覆盖（thincoder 裁剪版）

### 3.1 Agent-side（IDE → agent）—— 11/13

| Method | 做 | 说明 |
|---|---|---|
| `initialize` | ✅ | 版本协商（protocolVersion 1）；返回 agentInfo、能力矩阵、authMethods（terminal） |
| `authenticate` | ✅ | 校验 `~/.thincoder/config.json` 存在已配置 provider；缺失 → `authRequired` 错误码 -32000 |
| `session/new` | ✅ | 接受 `cwd` / `mcpServers`；返回 configOptions（model/thinking/mode） |
| `session/load` | ✅ | 恢复 thincoder 会话存档（双线历史 JSON），经 session/update 重放历史 |
| `session/resume` | ✅ | 轻量变体（跳过历史重放） |
| `session/list` | ✅ | 枚举会话存档（5 槽位） |
| `session/delete` | ✅ | 删除会话存档（schema v1 有、kimi 未实现——客户端清理会话的必需能力） |
| `session/prompt` | ✅ | 接受 text/image/resource 块；流式 `agent_message_chunk` |
| `session/cancel` | ✅ | 中断当前轮（复用 signal 中断机制） |
| `session/set_mode` | ✅ | plan/normal 模式切换（映射 configOption mode） |
| `session/set_config_option` | ✅ | model / thinking 统一分发（映射 thincoder /model、/think 语义） |
| `session/close`、`logout` | ❌ | close 由进程生命周期兜底；logout 不支持（无账号体系） |

### 3.2 Client-side reverse-RPC（agent → IDE）—— 5/9

| Method | 做 | 说明 |
|---|---|---|
| `session/update` | ✅ | 事件块见 4.3（含 agent_message_chunk / **agent_thought_chunk** / tool_call / tool_call_update / plan / usage_update / end_turn 等） |
| `session/request_permission` | ✅ | 工具审批 + 提问（askPermission 的 ACP 实现） |
| `fs/read_text_file` | ✅ | read 工具路由到 client（IDE 编辑器读取） |
| `fs/write_text_file` | ✅ | write/edit/apply_patch/delete 的写路径路由到 client（IDE diff 应用） |
| `terminal/create·output·release·kill·wait_for_exit` | ❌ | shell 走本地执行（与 kimi 相同取舍） |

### 3.3 其余（unstable 扩展：elicitation/*、auth/configuration、buffer sync 等）—— 不做

## 4. 架构映射（thincoder 零依赖约束）

```
bin/thincoder.mjs  ── "acp" 子命令 ──▶ src/acp.mjs
                                        │
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
              transport.mjs       session.mjs          bridge.mjs
              (NDJSON JSON-RPC   (AcpSession:          (runAgent 事件桥
               stdio 层, ~100 行   method → agent 映射)    callbacks + askPermission)
```

### 4.1 传输层（自写，零依赖）

ACP 官方 SDK（`@agentclientprotocol/sdk`）是 npm 依赖——违反零依赖哲学。自写精简层：

- `readline` 逐行读 stdin → JSON.parse → 分发
- 响应/通知写 stdout（**严格只写 JSON**——日志全走 stderr，kimi log-guard 同款）
- 请求 ID 匹配 + 错误码映射（-32602 invalidParams / -32000 authRequired / -32601 methodNotFound）
- SIGINT/SIGTERM → graceful drain（等待进行中请求结束再退出）

### 4.2 会话层（AcpSession）

每个 `session/new` 创建独立 agent 实例（复用 `createAgent`）：
- `cwd` → agent 工作目录（文件工具边界随之迁移）
- `mcpServers`（client 提供）→ 转发进 MCP 工具集
- configOptions：model（映射 `selectProviderModel`）/ mode（plan ⇄ normal）/ thinking

### 4.3 事件桥（bridge.mjs）

runAgent 的 callbacks 已有 6 个钩子——直接映射：

| runAgent 内部 | ACP 通知（session/update 事件块，schema v1） |
|---|---|
| `callbacks.onToken(text)` | `agent_message_chunk` |
| `callbacks.onReasoning` | **`agent_thought_chunk`**（schema v1 专用事件块，非 message chunk） |
| 工具开始/结果（tool loop 内） | `tool_call` / `tool_call_update` |
| plan mode 切换 | `plan` 事件块 |
| `callbacks.onUsage` | `usage_update`（token 统计） |
| 回合结束 | `end_turn` |
| 模型/模式变更 | `config_option_update` / `current_mode_update` |
| `callbacks.onCompress` | 压缩提示（保持透明） |

**工具执行钩子**：agent.mjs 工具循环当前直接调 toolByName——需在 ACP 模式下注入两个可插拔点：
1. **fs 读写路由**：read/write/edit/apply_patch/delete → 改走 `fs/read_text_file`/`fs/write_text_file` 反向 RPC（write 类工具先反查 client 当前 buffer 再应用，diff 由 IDE 呈现）
2. **审批**：副作用工具执行前 → `session/request_permission`（替代 TTY askPermission；ACP 下无 TTY，判定逻辑改为"有 ACP 权限通道即用通道"）

### 4.4 鉴权与配置

- 复用 `~/.thincoder/config.json`：provider 已配置 → `authenticate` 通过；未配置 → 返回 authRequired，客户端引导终端先跑 `thincoder` 完成 setup-wizard
- `initialize.authMethods` 声明 `terminal`（与 kimi 同款）

### 4.5 会话持久化

- `session/load`/`resume` 读 thincoder 会话存档（src/session.mjs，双线历史 JSON）
- `session/list` 枚举存档槽位
- ACP 会话本身**不写存档**（由客户端管理生命周期）——最小侵入

## 5. 安全语义

- 副作用工具：默认 **deny**，`request_permission` 必现（AUTO 配置在 ACP 会话中默认关闭，除非 config 显式开启）
- 工具边界：仍受 cwd 约束（现有 confine 逻辑不变）
- 写路径走 IDE buffer：IDE 的 diff 审查是比 CLI diff 预览更强的保障
- 日志隔离：stdout 纯净 JSON，stderr 承载日志——防止协议污染（kimi log-guard 同款）

## 6. 测试策略

`test/acp.test.mjs`——**mock ACP 客户端**驱动（起子进程或直接 import 传输层）：
1. initialize → authenticate → session/new 全链路
2. prompt → agent_message_chunk 流式
3. 工具调用：request_permission → approve → tool_result 回环（mock fs 反向 RPC）
4. cancel 中断
5. session/load/resume 重放
6. 错误映射（未鉴权 / 未知方法 / 非法 JSON）
7. 零依赖约束：`npm test` 全量含新测试

## 7. 不做项（明确裁剪）

| 不做 | 理由 |
|---|---|
| `session/close`、`logout` | 进程生命周期兜底；无账号体系 |
| terminal 反向 RPC | shell 本地执行（kimi 同取舍） |
| unstable 扩展（elicitation/*、auth/configuration、buffer sync、inline-edit 预测等） | 正常客户端流程不依赖 |
| audio prompt | 无音频输入通道 |
| ACP 会话写存档 | 客户端管生命周期 |
| 依赖官方 SDK（TS/Rust/Kotlin 等） | 零依赖哲学；自写层 ~100 行可测（schema v1 是唯一权威） |

## 8. 决策记录

| 决策 | 理由 |
|---|---|
| 自写 NDJSON JSON-RPC 层 | 零依赖是项目宪法；SDK 依赖会破坏 npm 安装的零依赖承诺 |
| fs 反向 RPC 全做（含 write 类） | "编辑器接线"是 ACP 核心体验——diff 就地显示是用户感知最强的点 |
| 权限默认 deny + AUTO 关闭 | 安全第一；ACP 会话在 IDE 内，审批弹窗成本低 |
| 复用终端鉴权 | 登录一次多表面（kimi 验证过的模式） |
| 新文件 src/acp.mjs + bridge 可插拔点，不改 runAgent 主路径 | 最小侵入——ACL 是独立表面，不污染 TUI/CLI 路径 |

## 9. 里程碑

- M1：传输层 + initialize/authenticate/session/new + prompt 流式（无工具）——Zed 能对话
- M2：工具调用 + request_permission + fs 反向 RPC——Zed 能完整干活
- M3：session/load/resume/list + config_options + cancel——日常使用闭环
- M4：测试完备 + 文档（ides.md 集成指南）——发布 0.13.0
