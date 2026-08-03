/**
 * tool 配对协议回归测试（DeepSeek 严格校验 400:
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"）。
 * 覆盖：normalizeToolPairing 发送前规范化 + runAgent 并行多模态调用的历史排序。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { normalizeToolPairing } from "../src/provider/core.mjs"

/** 校验 OpenAI tool 协议：每个 tool 消息必须紧跟在声明了其 tool_call_id 的 assistant 之后（中间不得有其他角色） */
function assertPairingValid(messages, label = "") {
  const pending = new Set()
  for (const m of messages) {
    if (m.role === "assistant") {
      pending.clear()
      for (const tc of m.tool_calls ?? []) pending.add(tc.id)
      continue
    }
    if (m.role === "tool") {
      assert.ok(pending.has(m.tool_call_id), `${label}孤儿 tool 消息: ${m.tool_call_id}`)
      pending.delete(m.tool_call_id)
      continue
    }
    pending.clear()
  }
  assert.equal(pending.size, 0, `${label}悬空 tool_calls 无结果: ${[...pending].join(", ")}`)
}

const asst = (ids) => ({
  role: "assistant",
  content: null,
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "t", arguments: "{}" } })),
})
const tool = (id, content = "ok") => ({ role: "tool", tool_call_id: id, content })

// ---------------------------------------------------------------- normalizeToolPairing 单元

test("normalizeToolPairing: 无 tool 消息原样返回（同引用）", () => {
  const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]
  assert.equal(normalizeToolPairing(msgs), msgs)
})

test("normalizeToolPairing: 已合法的历史保持顺序", () => {
  const msgs = [
    { role: "user", content: "hi" },
    asst(["a", "b"]),
    tool("a"), tool("b"),
    { role: "assistant", content: "done" },
  ]
  const out = normalizeToolPairing(msgs)
  assertPairingValid(out)
  assert.deepEqual(out, msgs)
})

test("normalizeToolPairing: 并行结果之间插入 user 消息 → 重排为紧邻", () => {
  // 并行 read_image 的历史形态: assistant(tc a,b) → tool a → user(image) → tool b
  const msgs = [
    asst(["a", "b"]),
    tool("a"),
    { role: "user", content: [{ type: "text", text: "img" }] },
    tool("b"),
  ]
  const out = normalizeToolPairing(msgs)
  assertPairingValid(out)
  assert.deepEqual(out.map((m) => m.role), ["assistant", "tool", "tool", "user"])
})

test("normalizeToolPairing: 孤儿 tool 消息（owner 被压缩掉）→ 丢弃", () => {
  const msgs = [
    { role: "user", content: "summary note" },
    tool("ghost"),
    asst(["a"]),
    tool("a"),
  ]
  const out = normalizeToolPairing(msgs)
  assertPairingValid(out)
  assert.ok(!out.some((m) => m.tool_call_id === "ghost"))
})

test("normalizeToolPairing: 悬空 tool_call（中断的会话）→ 合成占位结果", () => {
  const msgs = [asst(["a", "b"]), tool("a"), { role: "user", content: "[User interrupt: stop]" }]
  const out = normalizeToolPairing(msgs)
  assertPairingValid(out)
  const synthesized = out.find((m) => m.tool_call_id === "b")
  assert.equal(synthesized.role, "tool")
  assert.match(synthesized.content, /Tool result missing/)
})

// ---------------------------------------------------------------- chat() 发送时的线上载荷

/** 本地 mock LLM server：支持并行 tool_calls 脚本；requests 捕获请求体 */
function mockLLM(script) {
  return import("node:http").then(({ createServer }) => {
    let i = 0
    const requests = []
    const server = createServer((req, res) => {
      let bodyText = ""
      req.on("data", (c) => (bodyText += c))
      req.on("end", () => {
        requests.push(JSON.parse(bodyText))
        const step = script[Math.min(i++, script.length - 1)]
        const frames = step.toolCalls
          ? step.toolCalls.map((tc, idx) =>
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: `call_${idx}`, function: { name: tc.name, arguments: tc.arguments ?? "{}" } }] } }] })}\n\n`
            ).join("") +
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
          : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: step.content } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end(frames)
      })
    })
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }))
    })
  })
}

test("chat: 发送前规范化线上载荷 — 插入 user 的并行 tool 历史对严格提供商合法", async () => {
  const { chat } = await import("../src/provider/index.mjs")
  const { server, port, requests } = await mockLLM([{ content: "答" }])
  try {
    // 模拟并行 read_image 产生的历史（含 base64 图片 user 消息嵌在 tool 结果之间）
    const poisoned = [
      { role: "user", content: "看看这张图" },
      asst(["a", "b"]),
      tool("a", "[read_image: a.png]"),
      { role: "user", content: [{ type: "text", text: "img" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      tool("b", "file content"),
    ]
    const provider = { baseURL: `http://127.0.0.1:${port}`, apiKey: "x", model: "deepseek-v4-flash" }
    await chat(provider, { messages: poisoned })
    assertPairingValid(requests.at(-1).messages, "线上载荷")
    // 历史本身不被修改（图片消息仍在原位，切回视觉模型可恢复）
    assert.equal(poisoned[3].role, "user")
    assert.equal(poisoned[4].tool_call_id, "b")
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------- runAgent 源头修复

test("runAgent: 并行 read_image + 普通工具 — tool 结果全部紧邻，user 消息延后", async () => {
  const { createAgent, runAgent } = await import("../src/agent.mjs")
  const fakeVisionTool = {
    name: "read_image",
    description: "fake multimodal",
    parameters: { type: "object", properties: {} },
    readonly: true,
    multimodal: true,
    execute: async () => JSON.stringify({
      text: "[read_image: a.png (image/png, 3 bytes)]",
      images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
    }),
  }
  const fakeReadTool = {
    name: "read",
    description: "fake read",
    parameters: { type: "object", properties: {} },
    readonly: true,
    execute: async () => "file content",
  }
  // 第一轮：并行调用 read_image + read；第二轮：收尾
  const script = [{ toolCalls: [{ name: "read_image" }, { name: "read" }] }, { content: "看完了" }]
  const { server, port, requests } = await mockLLM(script)
  try {
    // deepseek-v4-flash：文本模型，走 "NOT injected" 提醒路径
    const provider = { baseURL: `http://127.0.0.1:${port}`, apiKey: "x", model: "deepseek-v4-flash" }
    const cwd = mkdtempSync(join(tmpdir(), "thincoder-pairing-test-"))
    const agent = createAgent({ provider, tools: [fakeVisionTool, fakeReadTool], config: {}, cwd })
    const out = await runAgent(agent, "看看图再读文件", {})
    assert.equal(out, "看完了")
    // 历史本身就已合法：两个 tool 结果紧邻 assistant，提醒消息在其后
    assertPairingValid(agent.history.filter((m) => m.role !== "system"), "agent.history")
    const assistantIdx = agent.history.findIndex((m) => m.tool_calls?.length)
    assert.equal(agent.history[assistantIdx + 1].role, "tool")
    assert.equal(agent.history[assistantIdx + 2].role, "tool")
    // 第二次请求的线上载荷也合法
    assertPairingValid(requests.at(-1).messages.slice(1), "第二次请求") // slice(1) 去掉 system
    rmSync(cwd, { recursive: true, force: true })
  } finally {
    server.close()
  }
})
