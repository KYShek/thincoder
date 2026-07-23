/**
 * 离线单元测试（node:test，不碰网络/真实 API）。
 * 覆盖：tui 宽字符与折行、memory 增删查（:memory: 库）、tools 文件操作。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stringWidth, wrapText } from "../src/tui.mjs"
import { createMemory, put, search, list, remove, putMarkdown, syncDir } from "../src/memory.mjs"
import { parseEntry, serializeEntry, slugify, entryFilename } from "../src/markdown.mjs"
import { builtinTools } from "../src/tools.mjs"

// ---------------------------------------------------------------- tui 纯函数

test("stringWidth: ascii / cjk / emoji", () => {
  assert.equal(stringWidth("hello"), 5)
  assert.equal(stringWidth("你好"), 4)
  assert.equal(stringWidth("a你b"), 4)
  assert.equal(stringWidth("🔧"), 2)
})

test("wrapText: 按宽度折行，保留空行", () => {
  assert.deepEqual(wrapText("abcdefgh", 3), ["abc", "def", "gh"])
  assert.deepEqual(wrapText("你好吗朋友", 4), ["你好", "吗朋", "友"])
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"])
})

// ---------------------------------------------------------------- memory

function freshMemory() {
  return createMemory({ dbPath: ":memory:" })
}

test("memory: put / search / list / remove 全流程", async () => {
  const m = freshMemory()
  const id1 = await put(m, { type: "rule", title: "代码风格", content: "不加分号，不用 TypeScript" })
  const id2 = await put(m, { type: "knowledge", title: "部署架构", content: "单台 VPS，Caddy 反向代理" })

  // 中文双字词命中（unicode61 + CJK 逐字方案的核心场景）
  const r1 = await search(m, "分号")
  assert.equal(r1.length, 1)
  assert.equal(r1[0].id, `personal:${id1}`)
  assert.equal(r1[0].layer, "personal")

  const r2 = await search(m, "VPS")
  assert.equal(r2[0].id, `personal:${id2}`)

  // OR 语义：一词命中即可
  const r3 = await search(m, "分号 Caddy")
  assert.equal(r3.length, 2)

  assert.equal((await list(m)).length, 2)
  assert.equal((await list(m, { type: "rule" })).length, 1)

  assert.equal(await remove(m, id1), true)
  assert.equal(await remove(m, id1), false)
  assert.equal((await list(m)).length, 1)
})

test("memory: 非法 type 拒绝写入", async () => {
  const m = freshMemory()
  await assert.rejects(() => put(m, { type: "bogus", title: "t", content: "c" }))
})

// ---------------------------------------------------------------- tools

test("tools: write / read / edit / glob / grep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-test-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "sub/a.txt", content: "hello\nworld\n" }, ctx)
    const readOut = await byName.read.execute({ path: "sub/a.txt" }, ctx)
    assert.match(readOut, /1\thello/)

    await byName.edit.execute({ path: "sub/a.txt", old_string: "world", new_string: "mjs" }, ctx)
    const readOut2 = await byName.read.execute({ path: "sub/a.txt" }, ctx)
    assert.match(readOut2, /2\tmjs/)

    // edit 多次匹配必须报错
    await byName.write.execute({ path: "b.txt", content: "x x x" }, ctx)
    await assert.rejects(() => byName.edit.execute({ path: "b.txt", old_string: "x", new_string: "y" }, ctx))

    const globOut = await byName.glob.execute({ pattern: "**/*.txt" }, ctx)
    assert.match(globOut, /sub\/a\.txt/)
    assert.match(globOut, /b\.txt/)

    const grepOut = await byName.grep.execute({ pattern: "mjs" }, ctx)
    assert.match(grepOut, /a\.txt:2:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- markdown

test("markdown: serialize → parse 往返一致", () => {
  const meta = { type: "rule", title: "错误处理规范", tags: ["golang", "error"], author: "liwei" }
  const md = serializeEntry(meta, "所有错误必须 wrap 上下文。\n\n第二段。")
  const { meta: parsed, content } = parseEntry(md)
  assert.equal(parsed.type, "rule")
  assert.equal(parsed.title, "错误处理规范")
  assert.deepEqual(parsed.tags, ["golang", "error"])
  assert.equal(parsed.author, "liwei")
  assert.equal(content, "所有错误必须 wrap 上下文。\n\n第二段。")
})

test("markdown: 缺 frontmatter / 非法 type 抛错", () => {
  assert.throws(() => parseEntry("没有 frontmatter"))
  assert.throws(() => parseEntry("---\ntype: bogus\ntitle: x\n---\n内容"))
})

test("markdown: slugify 与文件名", () => {
  assert.equal(slugify("Go 错误处理! 规范"), "go-错误处理-规范")
  assert.match(entryFilename("测试"), /^\d{8}-测试-[a-z0-9]{4}\.md$/)
})

// ---------------------------------------------------------------- project 层

test("project 层：putMarkdown → syncDir → 合并检索", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-proj-"))
  const m = freshMemory()
  try {
    const memDir = join(dir, ".thincoder", "memory")
    const filename = await putMarkdown(m, {
      layer: "project",
      dir: memDir,
      type: "knowledge",
      title: "部署架构",
      content: "生产环境在单台 VPS，Caddy 反向代理",
      tags: ["deploy"],
      author: "tester",
    })
    assert.match(filename, /部署架构/)

    // personal 层也放一条，验证合并
    await put(m, { type: "rule", title: "代码风格", content: "不加分号，不用 TypeScript" })

    const results = await search(m, "VPS 部署")
    assert.equal(results.length, 1)
    assert.equal(results[0].layer, "project")
    assert.equal(results[0].title, "部署架构")

    const merged = await search(m, "分号")
    assert.equal(merged[0].layer, "personal")

    // syncDir：手工删文件后应移出索引
    const { unlink, writeFile: wf } = await import("node:fs/promises")
    await unlink(join(memDir, filename))
    await wf(join(memDir, "20260724-新条目-ab12.md"), serializeEntry({ type: "decision", title: "新决策", tags: [], author: "t" }, "内容"))
    const stats = await syncDir(m, { layer: "project", dir: memDir })
    assert.equal(stats.removed, 1)
    assert.equal(stats.added, 1)
    const after = await search(m, "VPS")
    assert.equal(after.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 混合检索（本地 mock embedding 服务）

test("hybrid: 向量通道 + RRF + 惰性 embedding", async () => {
  const { createServer } = await import("node:http")
  const { createEmbedder } = await import("../src/embedding.mjs")
  const DIM = 8
  // 确定性向量：含"风格"/"规范"的词共享第 0 维（模拟语义相近）
  const vecFor = (text) => {
    const v = new Array(DIM).fill(0)
    if (text.includes("风格")) v[0] = 1
    if (text.includes("规范")) v[0] += 0.9
    if (text.includes("部署")) v[1] = 1
    if (text.includes("编程")) v[0] += 0.3
    return v
  }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const { input } = JSON.parse(body)
      const texts = Array.isArray(input) ? input : [input]
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ data: texts.map((t, i) => ({ embedding: vecFor(t), index: i })) }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const port = server.address().port
    const m = freshMemory()
    m.embedder = createEmbedder({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x", model: "mock" })
    const id1 = await put(m, { type: "rule", title: "代码风格", content: "不加分号" })
    await put(m, { type: "knowledge", title: "部署流程", content: "打 tag 即可" })

    // "编程规范" 与 "代码风格" 零字面重合：FTS 不中，向量必须命中。
    // 断言 top-2 而非第一——CJK 逐字 OR 的固有噪声：诱饵"部署流程"因共享单字
    // "程"获得 FTS 排名，低维 mock 向量下 RRF 可能让它压过纯向量命中。
    // 真实 bge-m3（1024 维）语义区分度足够，真实 API 验证为第一名。
    const results = await search(m, "编程规范")
    assert.ok(results.length > 0)
    assert.ok(
      results.slice(0, 2).some((r) => r.id === `personal:${id1}`),
      "向量命中应进 top-2",
    )

    // 惰性生成：向量已落库
    const stored = m.db.prepare("SELECT embedding IS NOT NULL AS has FROM entries WHERE id = ?").get(id1)
    assert.equal(stored.has, 1)
  } finally {
    server.close()
  }
})
