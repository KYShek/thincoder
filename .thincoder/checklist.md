# Checklist — ACP 接入（M1 起步）

> 播种自 ACP-CLIENT.md 用户故事（需求层跟踪）。

- [ ] 用户故事：Zed 用户在 IDE 直接对话 thincoder（编辑器上下文注入）
- [ ] 用户故事：JetBrains 用户在 AI chat 驱动 thincoder（审批弹 IDE 内）
- [ ] 用户故事：多编辑器用户一次登录多处可用（会话/鉴权复用）
- [ ] 用户故事：工程师审查 agent 编辑（fs 反向 RPC → IDE 原生 diff）
- [ ] M1：传输层 + initialize/authenticate/session/new + prompt 流式（无工具）——Zed 能对话
- [ ] M2：工具调用 + request_permission + fs 反向 RPC——Zed 能完整干活
- [ ] M3：session/load/resume/list/delete + config_options + cancel——日常使用闭环
- [ ] M4：测试完备 + ides.md 集成指南——发布 0.13.0
