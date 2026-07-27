const VALID_TASK_STATUS = new Set(["pending", "in_progress", "done"])

/**
 * task tool: multi-step task planning and progress tracking (Claude Code's todo mode).
 * Each call replaces the entire list; only modifies agent internal state (no external world), so readonly.
 * Accesses the caller agent via ctx.agent (injected by runAgent).
 */
export const taskTool = {
  name: "task",
  description:
    "Plan and track a task list for complex multi-step work. Replaces the entire list on each call.\n" +
    "\n" +
    "When to use:\n" +
    "- Multi-step tasks that span several tool calls — create the list BEFORE starting work\n" +
    "- After receiving new multi-step instructions, capture the requirements as tasks first\n" +
    "- Planning a sequence of edits before making them\n" +
    "- Tracking investigation progress across a large codebase search\n" +
    "\n" +
    "When NOT to use:\n" +
    "- Single-shot requests answerable in one or two tool calls\n" +
    "- Trivial requests or purely conversational replies\n" +
    "\n" +
    "Discipline:\n" +
    "- Keep exactly ONE item in_progress; mark it before starting that item\n" +
    "- CALL THIS TOOL AGAIN to mark each item done as soon as you complete it — do not batch completions at the end\n" +
    "- Never mark an item done if tests are failing, the implementation is partial, or errors remain\n" +
    "- If blocked, keep the item in_progress (or add a new pending item describing the blocker) and tell the user\n" +
    "- Avoid churn: don't re-call without real progress; never finish with stale pending items\n" +
    "\n" +
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
    ctx.agent._turnsSinceTaskUpdate = 0
    ctx.agent._onTaskUpdate?.(items)
    const done = items.filter((i) => i.status === "done").length
    const open = items.length - done
    return `Task list updated: ${done}/${items.length} done` +
      (open > 0 ? ` — ${open} item(s) still open; call task again as you complete them.` : " — all done.") +
      `\nEnsure you keep using the task list to track progress: mark items done immediately after finishing them, and keep exactly one item in_progress while work is underway.`
  },
}
