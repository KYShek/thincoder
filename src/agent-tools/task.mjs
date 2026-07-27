const VALID_TASK_STATUS = new Set(["pending", "in_progress", "done"])

/**
 * task tool: multi-step task planning and progress tracking (Claude Code's todo mode).
 * Each call replaces the entire list; only modifies agent internal state (no external world), so readonly.
 * Accesses the caller agent via ctx.agent (injected by runAgent).
 */
export const taskTool = {
  name: "task",
  description:
    "Plan and track a task list for complex multi-step work. Each call replaces the entire list. " +
    "Keep exactly one item in_progress at a time; mark items done as you complete them; never mark done if tests fail or work is partial. " +
    "Statuses: pending | in_progress | done.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["items"],
  },
  readonly: true,
  async execute(args, ctx) {
    // Keep only non-done items + the 3 most recently completed (for context reference), max 20 to prevent accumulation
    const raw = (args.items ?? []).map((it) => ({
      title: String(it.title ?? "").slice(0, 200),
      status: VALID_TASK_STATUS.has(it.status) ? it.status : "pending",
    }))
    const pending = raw.filter((t) => t.status !== "done")
    const recentDone = raw.filter((t) => t.status === "done").slice(-3)
    const items = [...pending, ...recentDone].slice(0, 20)
    ctx.agent.tasks = items
    ctx.agent._onTaskUpdate?.(items)
    const done = items.filter((i) => i.status === "done").length
    const open = items.length - done
    return `Task list updated: ${done}/${items.length} done` +
      (open > 0 ? ` — ${open} item(s) still open.` : " — all done.")
  },
}
