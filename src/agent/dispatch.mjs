/**
 * agent/dispatch.mjs — 工具调用两段式执行
 */
import { offloadToolResult } from "./helpers.mjs"

/**
 * 两段式执行：
 * 阶段一（串行）：逐个解析参数 + planMode 检查 + 权限确认（有副作用工具）
 * 阶段二（保序执行）：严格按模型调用顺序——连续的只读/parallel 工具并发成组，
 * 有副作用工具在原位置逐个串行（写后读同一文件的一批调用，读必须看到写后的内容）。
 * 返回按调用顺序排列的结果数组（每项含 ok 标记执行成败）。
 */
export async function executeToolCalls(agent, toolByName, toolCalls, callbacks, depth = 0, signal) {
  // ---- 阶段一：串行准备 ----
  const prepared = []
  for (const toolCall of toolCalls) {
    const tool = toolByName.get(toolCall.name)
    let args = {}
    try {
      args = JSON.parse(toolCall.arguments || "{}")
    } catch {
      prepared.push({ toolCall, tool: null, error: `Invalid tool arguments JSON: ${toolCall.arguments}` })
      continue
    }

    if (!tool) {
      prepared.push({ toolCall, tool: null, error: `Unknown tool: ${toolCall.name}` })
      continue
    }

    if (agent.planMode && !tool.readonly) {
      prepared.push({ toolCall, tool, denied: true, reason: "plan mode" })
      continue
    }

    if (!tool.readonly) {
      // autoApprove 短路：agent 已标记自动批准时不再询问
      const allowed = agent.autoApprove
        ? true
        : callbacks.onPermissionRequest
          ? await callbacks.onPermissionRequest(toolCall.name, args)
          : false
      if (!allowed) {
        prepared.push({ toolCall, tool, denied: true, reason: callbacks.onPermissionRequest ? "denied by user" : "no permission handler" })
        continue
      }
    }

    callbacks.onToolCall?.(toolCall.name, args)
    prepared.push({ toolCall, tool, args })
  }

  // ---- 阶段二：保序执行 ----
  const runOne = async (item) => {
    if (item.error) return { ...item, result: `Error: ${item.error}`, ok: false }
    if (item.denied) {
      const reason = item.reason === "plan mode"
        ? "Error: plan mode is active — only read-only tools are allowed. Exit plan mode first."
        : "Error: permission denied by user"
      return { ...item, result: reason, ok: false }
    }
    try {
      const rawResult = await item.tool.execute(item.args, {
        cwd: agent.cwd,
        agent,
        depth,
        signal,
        callbacks,
        onOutput: (chunk) => callbacks.onToolOutput?.(item.toolCall.name, chunk),
        onQuestion: callbacks.onQuestion,
        onPermissionRequest: callbacks.onPermissionRequest,
      })
      if (rawResult === undefined) throw new Error(`Tool "${item.toolCall.name}" returned undefined — all tools must return a string value`)
      const raw = String(rawResult)
      const result = item.toolCall.name === "read_image" ? raw : await offloadToolResult(raw, item.toolCall.id)
      callbacks.onToolResult?.(item.toolCall.name, result)
      return { ...item, result, ok: true }
    } catch (error) {
      return { ...item, result: `Error: ${error.message}`, ok: false }
    }
  }

  const results = []
  let batch = []
  const flush = async () => {
    if (batch.length === 0) return
    results.push(...await Promise.all(batch.map(runOne)))
    batch = []
  }
  for (const item of prepared) {
    if (item.tool && !item.tool.readonly && !item.tool.parallel) {
      await flush()
      results.push(await runOne(item))
    } else {
      batch.push(item)
    }
  }
  await flush()
  return results
}
