/** /goal command: set/view/cancel long-term goal.
 *  Extracted from slash-commands.mjs.
 *  ctx: { agent, pushLine, pushLabel, openPicker, askQuestion } */
export async function handleGoalCommand(ctx) {
  const { agent, pushLine, pushLabel, openPicker, askQuestion } = ctx
  const entries = [
    { type: "header", text: agent.goal ? `Current goal: ${agent.goal.objective.slice(0, 60)}` : "Actions" },
    { type: "item", text: "Set new goal", action: "set" },
  ]
  if (agent.goal) {
    entries.push({ type: "item", text: "Cancel goal", action: "cancel" })
    entries.push({ type: "item", text: "View details", action: "view" })
  }
  openPicker({
    title: "Goal",
    entries,
    onSelect: async (e) => {
      if (e.action === "view") {
        const statusText = { active: "active", complete: "completed", blocked: "blocked" }[agent.goal.status] ?? agent.goal.status
        pushLine(`Goal: ${agent.goal.objective}`, C.tool)
        if (agent.goal.criteria) pushLine(`  Criteria: ${agent.goal.criteria}`, C.dim)
        pushLine(`  Status: ${statusText} │ Turns used: ${agent.goal.turnsUsed ?? 0} │ Set at: ${new Date(agent.goal.setAt).toLocaleString()}`, C.dim)
        return
      }
      if (e.action === "cancel") {
        agent.goal = null
        return
      }
      // set — requires entering goal text
      const goalText = await askQuestion("Enter goal description (; separates criteria)")
      if (!goalText) return
      const semi = goalText.indexOf("；") >= 0 ? "；" : goalText.indexOf(";") >= 0 ? ";" : null
      const objective = semi ? goalText.slice(0, semi).trim() : goalText.trim()
      const criteria = semi ? goalText.slice(semi + 1).trim() : ""
      agent.goal = { objective, criteria, setAt: Date.now(), status: "active", turnsUsed: 0, _blockTally: null }
    },
  })
}
