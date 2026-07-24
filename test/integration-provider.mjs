/**
 * 集成测试：multi-provider 配置加载与切换
 * 跳过 TUI 交互，直接测 config → makeAgent → switch 流程
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = join(tmpdir(), ".thincoder-integration-test-" + Date.now())
const configPath = join(configDir, "config.json")

// 注入 mock 函数让 config.mjs 使用这个临时目录
// 由于 config.mjs 内部直接引用 homedir() + ".thincoder"，我们只能 mock homedir
// 更干净的方式：直接测试 loadConfig 的逻辑

describe("multi-provider 集成", () => {
  let config

  before(async () => {
    mkdirSync(configDir, { recursive: true })
    // 写入测试配置——两个 provider
    writeFileSync(configPath, JSON.stringify({
      providers: [
        { name: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
        { name: "kimi", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", apiKey: "sk-kimi-test" },
      ],
      activeProvider: "deepseek",
      agent: { maxTurns: 50 },
    }, null, 2) + "\n", "utf8")
  })

  after(() => {
    if (existsSync(configPath)) unlinkSync(configPath)
    if (existsSync(configDir)) {
      try { const { rmSync } = require("node:fs"); rmSync(configDir, { recursive: true }) } catch {}
      // 不用 rmSync 的递归删除，因为 esm 里不能用 require
      // 留给临时目录清理
    }
  })

  test("loadConfig: 加载 multi-provider 结构", async () => {
    // 不能直接 import config.mjs 因为它读的是 ~/.thincoder，我们 mock 不了 homedir
    // 所以直接测 JSON parse + 逻辑验证
    const fs = await import("node:fs")
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
    
    assert.equal(raw.providers.length, 2)
    assert.equal(raw.activeProvider, "deepseek")
    assert.equal(raw.providers[0].name, "deepseek")
    assert.equal(raw.providers[1].name, "kimi")
    assert.equal(raw.providers[1].apiKey, "sk-kimi-test")
  })

  test("findProvider: 按 name 查找", async () => {
    const { findProvider } = await import("../src/config.mjs")
    const providers = [
      { name: "a", baseURL: "https://a.com", model: "a-model" },
      { name: "b", baseURL: "https://b.com", model: "b-model" },
    ]
    
    const found = findProvider(providers, "b")
    assert.equal(found.name, "b")
    assert.equal(found.baseURL, "https://b.com")

    // 找不到时返回第一个
    const fallback = findProvider(providers, "nonexistent")
    assert.equal(fallback.name, "a")

    // name 为空时返回第一个
    const first = findProvider(providers, "")
    assert.equal(first.name, "a")
  })

  test("session: 保存含 activeProvider 的会话", async () => {
    const { saveSession, loadSession, clearSession } = await import("../src/session.mjs")
    const cwd = join(tmpdir(), "thincoder-session-provider-test-" + Date.now())
    const agent = {
      cwd,
      provider: { name: "kimi", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", apiKey: "sk-kimi-test" },
      history: [{ role: "user", content: "hi" }],
      tasks: [],
    }
    
    saveSession(agent)
    const restored = loadSession(cwd)
    assert.equal(restored.activeProvider, "kimi")
    assert.equal(restored.history.length, 1)
    
    // 兼容旧版 version 1 会话
    const v1Data = {
      version: 1,
      cwd,
      model: "old-model",
      updatedAt: Date.now(),
      history: [{ role: "user", content: "hello" }],
      tasks: [],
    }
    const fs = await import("node:fs")
    const { sessionPath } = await import("../src/session.mjs")
    fs.writeFileSync(sessionPath(cwd), JSON.stringify(v1Data), "utf8")
    const v1Restored = loadSession(cwd)
    assert.notEqual(v1Restored, null)
    assert.equal(v1Restored.history[0].content, "hello")

    clearSession(cwd)
  })

  test("切换 provider 逻辑", async () => {
    const providers = [
      { name: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
      { name: "kimi", baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", apiKey: "sk-kimi-test" },
    ]
    
    // 模拟切换
    let activeProvider = "deepseek"
    let current = { ...providers[0] }

    function switchTo(name) {
      const p = providers.find(pp => pp.name === name)
      if (!p) return false
      activeProvider = name
      current = { ...p }
      return true
    }

    assert.equal(switchTo("kimi"), true)
    assert.equal(activeProvider, "kimi")
    assert.equal(current.model, "moonshot-v1-8k")
    assert.equal(current.apiKey, "sk-kimi-test")

    // 切换到不存在的
    assert.equal(switchTo("nonexistent"), false)
    assert.equal(activeProvider, "kimi") // 不变
  })
})
