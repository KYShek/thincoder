/**
 * plan tool: enter/exit plan mode.
 * In plan mode only read-only tools are allowed — explore code, design solutions, no code writing.
 * After the user approves the plan, exit plan mode and start implementing.
 */
export const planTool = {
  name: "plan",
  description:
    "Enter or exit plan mode. In plan mode you are restricted to READ-ONLY tools: read files, search code, run read-only shell commands. Use plan mode before complex multi-step tasks — explore the codebase, design the architecture, present a plan to the user. When the user approves, exit plan mode and implement. For simple single-file edits, skip plan mode and just make the change.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["enter", "exit"], description: "Enter or exit plan mode" },
    },
    required: ["action"],
  },
  readonly: true,
  async execute(args, ctx) {
    if (args.action === "exit") {
      ctx.agent.planMode = false
      ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
      ctx.agent._pendingReminders.push("[System reminder: plan mode is now OFF. Start implementing your plan — edit files, run commands. No need for a task list (plan already covered that) or further confirmation.]")
      return "Plan mode exited. You may now edit files and run commands."
    }
    ctx.agent.planMode = true
    ctx.agent._pendingReminders = ctx.agent._pendingReminders ?? []
    ctx.agent._pendingReminders.push("[System reminder: plan mode is now ON. Workflow: (1) explore/read codebase with read-only tools, (2) design a solution considering trade-offs, (3) present your plan by calling plan with action='exit' so the user can approve it. Only read-only tools are allowed — do not write, edit, or run mutation commands.]")
    return "Plan mode activated. You are now restricted to READ-ONLY tools. Explore the codebase, understand the architecture, design a solution. Present your plan to the user for approval before writing any code."
  },
}
