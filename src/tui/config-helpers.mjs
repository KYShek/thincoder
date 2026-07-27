import { existsSync, readFileSync } from "node:fs"

/** persistRaw / syncProviderField / maskKey: config read/write helpers.
 *  Extracted from index.mjs for shared use by slash-commands, wizard, and pickers.
 *  createConfigHelpers(agent) returns { persistRaw, syncProviderField, maskKey } */
export function createConfigHelpers(agent) {
  /** Read config.json → mutate → persist to disk */
  async function persistRaw(mutate) {
    const { saveConfig, configPath } = await import("../config.mjs")
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    saveConfig(raw)
  }

  /** Sync a field of the current provider to the providers array and persist to disk */
  async function syncProviderField(field, value) {
    const target = agent.providers.find((p) => p.name === agent.activeProvider)
    if (!target) return
    if (value === undefined) delete target[field]
    else target[field] = value
    await persistRaw((raw) => {
      raw.providers = agent.providers
    })
  }

  /** Mask API key for display */
  function maskKey(key) {
    if (!key) return "(none)"
    if (key.length <= 8) return "***"
    return key.slice(0, 5) + "\u2026" + key.slice(-4)
  }

  return { persistRaw, syncProviderField, maskKey }
}
