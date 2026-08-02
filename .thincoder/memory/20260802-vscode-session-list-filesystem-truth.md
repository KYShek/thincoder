# VS Code 会话列表：文件系统为唯一真相（无 Memento 索引）

**类型**: decision
**日期**: 2026-08-02

thincoder-vscode 会话列表已废掉 Memento 索引，文件系统为唯一真相：

- `listSessions(msgDir)`（session-io.mjs）扫 messages 目录、base64url 解码文件名得会话名、按文件 mtime 升序（=创建顺序，新建自然排最后）。
- Memento 只保留激活会话名（`sessionsKey()` / `_sessionKey()`）。
- `loadIndex`/`saveIndex` 及 chat-panel 全部用法已删。
- 会话文件双字段格式 `{messages, contextHistory}`；旧裸数组格式 `contextHistory=null`，调用方回退从人读线播种。
- `_generateTitle` rename 后直接更新激活指针；`_newSession`/`_deleteSession` 靠文件增删即真相。

背景：旧索引存在 workspaceState（Memento state.vscdb），读到非数组时 fallback `["Session 1"]`，代码只信索引从不看磁盘，导致磁盘上 6 个会话"消失"。
