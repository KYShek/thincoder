/**
 * bridge.mjs — map runAgent callbacks to ACP session/update notifications.
 *
 * Wire shapes verified against the ACP schema v1 + kimi acp-adapter
 * (events-map.ts): every update is `{ sessionId, update: { sessionUpdate: <kind>, ... } }`.
 * - agent text        → `agent_message_chunk` with `content: { type: "text", text }`
 * - thinking          → `agent_thought_chunk` with the same content shape
 * - usage             → `usage_update` with `usage`
 * End-of-turn is NOT a notification: `session/prompt` resolves with
 * `{ stopReason: "end_turn" }` (kimi session.ts parity).
 */

export function buildAcpCallbacks({ sessionId, notify, log = () => {} }) {
  const update = (sessionUpdate, extra = {}) =>
    notify("session/update", { sessionId, update: { sessionUpdate, ...extra } })

  return {
    onToken: (text) => update("agent_message_chunk", { content: { type: "text", text } }),
    onReasoning: (text) => update("agent_thought_chunk", { content: { type: "text", text } }),
    onUsage: (usage) => update("usage_update", { usage }),
    onWait: ({ phase, seconds }) => log(`[rate-limit] ${phase} waiting ~${seconds}s`),
    onCompress: () => log("[context] auto-compacted"),
    // onToolCall/onToolResult/onPermissionRequest/onTaskUpdate → M2 (tools)
  }
}
