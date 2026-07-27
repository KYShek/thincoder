import { ansi, C } from "./ansi.mjs"

/** /help 命令：列出所有斜杠命令及别名。
 *  ctx: { pushLine, pushLabel, SLASH_COMMANDS } */
export async function handleHelpCommand(ctx) {
  const { pushLine, pushLabel, SLASH_COMMANDS } = ctx
  const aliasList = { "/help": "/h", "/exit": "/x", "/model": "/m", "/plan": "/p", "/think": "/t", "/clear": "/c", "/new": "/n" }
  const order = ["Agent", "Session", "Tools", "Config"]
  const byGroup = new Map()
  for (const c of SLASH_COMMANDS) {
    if (!c.group) continue
    if (!byGroup.has(c.group)) byGroup.set(c.group, [])
    byGroup.get(c.group).push(c)
  }
  pushLabel(`❯ Help`, ansi.bold + C.tool)
  for (const group of order) {
    const cmds = byGroup.get(group)
    if (!cmds) continue
    pushLine(`  ${group}:`, C.dim)
    for (const c of cmds) {
      const alias = aliasList[c.name]
      pushLine(`    ${c.name.padEnd(12)}${alias ? ` (${alias})`.padEnd(8) : "        "} ${c.desc}`, C.text)
    }
  }
}
