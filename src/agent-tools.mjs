/**
 * agent-tools.mjs — 自律工具索引
 * 从 agent.mjs 通过动态 import 加载以避免 ESM 循环依赖。
 * 各工具实现在 agent-tools/ 子目录中。
 */
export { planTool } from "./agent-tools/plan.mjs"
export { subagentTool } from "./agent-tools/subagent.mjs"
export { taskTool } from "./agent-tools/task.mjs"
export { skillTool } from "./agent-tools/skill.mjs"
export { goalTool } from "./agent-tools/goal.mjs"
export { verifyTool } from "./agent-tools/verify.mjs"
export { recentChangesTool } from "./agent-tools/recent-changes.mjs"
