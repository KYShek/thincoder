/**
 * agent/dispatch.mjs — two-phase tool call execution
 */
import { offloadToolResult } from "./helpers.mjs"

/**
 * Two-phase execution:
 * Phase 1 (serial): parse args one by one + planMode check + permission confirmation (side-effecting tools)
 * Phase 2 (order-preserving): strictly preserve model call order — consecutive readonly/parallel tools run as concurrent batches,
 * side-effecting tools run serially in their original position (if a batch writes-then-reads the same file, the read must see the post-write content).
 * Returns a results array in call order (each entry has an ok flag indicating success/failure).
 */
export async function executeToolCalls(agent, toolByName, toolCalls, callbacks, depth = 0, signal) {
  // ---- Phase 1: serial preparation ----
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
      // autoApprove short-circuit: skip prompt when agent is already marked for auto-approval
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

  // ---- Phase 2: order-preserving execution ----
  const runOne = async (item) => {
    if (item.error) return { ...item, result: `Error: ${item.error}`, ok: false }
    if (item.denied) {
      const reason = item.reason === "plan mode"
        ? "Error: plan mode is active — only read-only tools are allowed. Exit plan mode first."
        : item.reason === "denied by user"
          ? "Error: permission denied by user"
          : "Error: no permission handler configured — this tool requires user approval but the current context doesn't support interaction (e.g. subagent or non-TUI mode)"
      return { ...item, result: reason, ok: false }
    }
    try {
      if (item.tool.outputPanel) callbacks.setupOutputPanel?.(item.toolCall.name)
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
      // Log full error for debugging; only pass message to the model (stack traces confuse LLMs and may leak paths)
      console.error(`[dispatch] tool "${item.toolCall.name}" failed:`, error)
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
