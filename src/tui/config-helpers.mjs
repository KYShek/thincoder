import { existsSync, readFileSync } from "node:fs"

/** persistRaw / syncProviderField / maskKey：配置读写辅助。
 *  从 index.mjs 抽出，供 slash-commands / wizard / pickers 共用。
 *  createConfigHelpers(agent) 返回 { persistRaw, syncProviderField, maskKey } */
export function createConfigHelpers(agent) {
  /** 读取 config.json → mutate → 落盘 */
  async function persistRaw(mutate) {
    const { saveConfig, configPath } = await import("../config.mjs")
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    mutate(raw)
    saveConfig(raw)
  }

  /** 同步当前 provider 的某个字段到 providers 数组并落盘 */
  async function syncProviderField(field, value) {
    const target = agent.providers.find((p) => p.name === agent.activeProvider)
    if (!target) return
    if (value === undefined) delete target[field]
    else target[field] = value
    await persistRaw((raw) => {
      raw.providers = agent.providers
    })
  }

  /** API key 脱敏显示 */
  function maskKey(key) {
    if (!key) return "(none)"
    if (key.length <= 8) return "***"
    return key.slice(0, 5) + "\u2026" + key.slice(-4)
  }

  return { persistRaw, syncProviderField, maskKey }
}
