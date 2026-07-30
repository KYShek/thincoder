import { ansi, C } from "./ansi.mjs"

/** /upgrade command: check for updates and optionally upgrade.
 *  ctx: { agent, pushLine, pushLabel, showPicker } */
export async function handleUpgradeCommand(ctx) {
  const { pushLine, pushLabel, showPicker } = ctx
  const { checkForUpdate } = await import("../upgrade.mjs")
  const { readFileSync } = await import("node:fs")

  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

  pushLabel(`❯ Upgrade`, ansi.bold + C.tool)
  pushLine(`Checking for updates...`, C.dim)
  const result = await checkForUpdate(pkg.version)
  if (!result) {
    pushLine(`Unable to query npm registry — check your network`, C.error)
    return
  }
  if (!result.newer) {
    pushLine(`✓ ThinCoder ${result.local} is already the latest.`, C.tool)
    return
  }
  pushLine(`thincoder ${result.latest} is available (current: ${result.local}).`, C.tool)
  const sel = await showPicker(`Update: ${result.local} → ${result.latest}`, [
    { type: "header", text: `New version: ${result.latest}` },
    { type: "item", text: "Upgrade now", action: "upgrade" },
    { type: "item", text: "Later", action: "later" },
  ])
  if (sel?.action !== "upgrade") return
  pushLabel(`❯ Upgrade`, ansi.bold + C.tool)
  pushLine(`Upgrading to ${result.latest}...`, C.tool)
  const { exec } = await import("node:child_process")
  const cp = exec("npm install -g thincoder@latest", { windowsHide: true })
  cp.stdout?.on("data", () => {})
  cp.stderr?.on("data", () => {})
  cp.on("close", (code) => {
    if (code === 0) {
      pushLine(`✓ Upgraded to ${result.latest}. Restart to apply.`, C.tool)
    } else {
      pushLine(`✗ Upgrade failed (exit ${code}). Run \`thincoder upgrade\` manually.`, C.error)
    }
  })
}
