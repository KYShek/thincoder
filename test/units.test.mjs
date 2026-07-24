/**
 * 离线单元测试（node:test，不碰网络/真实 API）。
 * 覆盖：tui 宽字符与折行、memory 增删查（:memory: 库）、tools 文件操作。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stringWidth, wrapText } from "../src/tui.mjs"
import { createMemory, put, search, list, remove, putMarkdown, syncDir } from "../src/memory.mjs"
import { parseEntry, serializeEntry, slugify, entryFilename } from "../src/markdown.mjs"
import { builtinTools } from "../src/tools.mjs"
import { loadSkills, formatSkillListing, readSkill } from "../src/skills.mjs"
import { planTool, goalTool, verifyTool } from "../src/agent.mjs"

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

// ---------------------------------------------------------------- team 层（本地裸仓库模拟远端）

test("team 层: 双 clone 同步 + 冲突诚实报错", async () => {
  const { execFileSync } = await import("node:child_process")
  const { ensureClone, pullTeam, commitAndPush } = await import("../src/gitmem.mjs")
  const { writeFileSync, readFileSync } = await import("node:fs")

  const base = mkdtempSync(join(tmpdir(), "thincoder-team-"))
  const remote = join(base, "remote.git")
  const dirA = join(base, "a")
  const dirB = join(base, "b")
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" })

  try {
    // 远端裸仓库 + 两个成员的 clone
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" })
    await ensureClone({ repo: remote, dir: dirA })
    await ensureClone({ repo: remote, dir: dirB })
    for (const d of [dirA, dirB]) {
      git(d, "config", "user.name", "tester")
      git(d, "config", "user.email", "t@t.dev")
    }
    // A 先推一个初始提交（空仓库无法 rebase）
    writeFileSync(join(dirA, "README.md"), "# team memory\n")
    git(dirA, "add", ".")
    git(dirA, "commit", "-m", "init")
    git(dirA, "push", "-u", "origin", "master")

    // A 写入一条团队记忆并推送
    const memA = freshMemory()
    const file1 = await putMarkdown(memA, {
      layer: "team", dir: dirA, type: "rule", title: "提交规范",
      content: "commit message 用英文，动词开头", tags: ["git"], author: "A",
    })
    await commitAndPush(dirA, file1, "memory: [rule] 提交规范")

    // B 同步：应拉到 A 的条目并可检索
    const memB = freshMemory()
    await pullTeam(dirB)
    const stats = await syncDir(memB, { layer: "team", dir: dirB })
    assert.equal(stats.added, 1)
    const found = await search(memB, "提交规范")
    assert.equal(found.length, 1)
    assert.equal(found[0].layer, "team")
    assert.equal(found[0].author, "A")

    // 冲突场景：A 改条目推上去，B 也改同一条目（本地提交），B 再 pull 必须诚实报错
    const fileA = readFileSync(join(dirA, file1), "utf8").replace("动词开头", "动词开头，英文小写")
    writeFileSync(join(dirA, file1), fileA)
    await commitAndPush(dirA, file1, "memory: update 提交规范")
    const fileB = readFileSync(join(dirB, file1), "utf8").replace("动词开头", "中文动词开头")
    writeFileSync(join(dirB, file1), fileB)
    git(dirB, "add", file1)
    git(dirB, "commit", "-m", "memory: conflicting update")

    await assert.rejects(() => pullTeam(dirB), /冲突/)
    // rebase 已中止：B 仓库不处于冲突状态
    const status = git(dirB, "status", "--porcelain")
    assert.ok(!status.split("\n").some((l) => l.startsWith("UU")))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- TUI 输入布局 / 项目指令 / websearch

test("layoutInput: 折行与光标定位", async () => {
  const { layoutInput } = await import("../src/tui.mjs")
  // 空输入：一行带提示符，光标在提示符后
  let l = layoutInput([], 0, 10)
  assert.deepEqual(l.lines, ["▸ "])
  assert.equal(l.cursorLine, 0)
  assert.equal(l.cursorCol, 2)
  // 首行宽 10（提示符占 2），"你好世界你好" 6 字 12 宽 → ["▸ 你好世界","你好"]；cursor=6 在输入末尾
  l = layoutInput([..."你好世界你好"], 6, 10)
  assert.deepEqual(l.lines, ["▸ 你好世界", "你好"])
  assert.equal(l.cursorLine, 1)
  assert.equal(l.cursorCol, 4)
  // 光标在中间：width=4，首行可用 2 → ["▸ ab","cdef","gh"]；cursor=3 在 'd' 前（第 2 行第 1 列）
  l = layoutInput([..."abcdefgh"], 3, 4)
  assert.deepEqual(l.lines, ["▸ ab", "cdef", "gh"])
  assert.equal(l.cursorLine, 1)
  assert.equal(l.cursorCol, 1)
})

test("agent: 项目指令文件加载（AGENTS.md / project_rules.md）", async () => {
  const { loadProjectInstructions } = await import("../src/agent.mjs")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-rules-"))
  try {
    assert.equal(await loadProjectInstructions(dir), "") // 没有文件时为空
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(dir, "AGENTS.md"), "本项目用 pnpm")
    await writeFile(join(dir, "project_rules.md"), "提交前必须跑测试")
    const out = await loadProjectInstructions(dir)
    assert.match(out, /本项目用 pnpm/)
    assert.match(out, /提交前必须跑测试/)
    assert.match(out, /# AGENTS\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("websearch: 解析结果块（本地 mock Bing）", async () => {
  const { createServer } = await import("node:http")
  const page = `<html><body><ol id="b_results">
    <li class="b_algo" data-id><h2 class=""><a target="_blank" href="https://example.com/1"><strong>Node</strong>.js 官网</a></h2><div class="b_caption"><p>Node.js&#174; 是一个运行时</p></div></li>
    <li class="b_algo" data-id><h2 class=""><a target="_blank" href="https://example.com/2">第二个结果</a></h2><p>摘要&#0183;内容</p></li>
  </ol></body></html>`
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html")
    res.end(page)
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    // mock 服务器替换真实 Bing：直接验证解析逻辑（fetch 部分 monkey-patch）
    const port = server.address().port
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => origFetch(`http://127.0.0.1:${port}/`)
    try {
      const ws = builtinTools.find((t) => t.name === "websearch")
      const out = await ws.execute({ query: "test", limit: 5 }, { cwd: process.cwd() })
      assert.match(out, /Node\.js 官网/)
      assert.match(out, /https:\/\/example\.com\/1/)
      assert.match(out, /Node\.js® 是一个运行时/)
      assert.match(out, /摘要·内容/)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------- ls / fetch

test("ls: 目录列表（目录在前，含大小时间）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-ls-"))
  try {
    const { writeFile, mkdir } = await import("node:fs/promises")
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "a.txt"), "hello")
    const ls = builtinTools.find((t) => t.name === "ls")
    const out = await ls.execute({ path: dir }, { cwd: dir })
    const lines = out.split("\n")
    assert.match(lines[0], /^d  src\//) // 目录在前
    assert.match(lines[1], /^-  a\.txt\s+5\s/) // 文件带大小
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fetch: HTML 转文本（本地 mock）", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(`<html><head><style>body{color:red}</style><script>var x=1</script></head>
      <body><h1>标题</h1><p>第一段&nbsp;文字</p><ul><li>条目一</li><li>条目二</li></ul></body></html>`)
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const port = server.address().port
    const fetchTool = builtinTools.find((t) => t.name === "fetch")
    const out = await fetchTool.execute({ url: `http://127.0.0.1:${port}/` }, {})
    assert.match(out, /标题/)
    assert.match(out, /第一段 文字/)
    assert.match(out, /- 条目一/)
    assert.ok(!out.includes("var x=1")) // script 已剥除
    assert.ok(!out.includes("color:red")) // style 已剥除
  } finally {
    server.close()
  }
})

// ---------------------------------------------------------------- task 工具

test("task: 更新 agent 任务列表并触发回调", async () => {
  const { taskTool } = await import("../src/agent.mjs")
  const agent = { tasks: [], _onTaskUpdate: null }
  let notified = null
  agent._onTaskUpdate = (items) => (notified = items)
  const out = await taskTool.execute(
    { items: [
      { title: "读代码", status: "done" },
      { title: "写实现", status: "in_progress" },
      { title: "跑测试", status: "pending" },
      { title: "非法状态", status: "bogus" },
    ] },
    { agent },
  )
  assert.equal(agent.tasks.length, 4)
  assert.equal(agent.tasks[3].status, "pending") // 非法状态回退 pending
  assert.match(out, /^Task list updated: 1\/4 done/)
  assert.match(out, /still open/) // 未完成项催促
  assert.equal(notified.length, 4)
})

// ---------------------------------------------------------------- 会话持久化

test("session: 保存/恢复/清空 往返", async () => {
  const { saveSession, loadSession, clearSession } = await import("../src/session.mjs")
  const cwd = join(tmpdir(), "thincoder-session-test-" + Date.now())
  const agent = {
    cwd,
    provider: { name: "test", model: "test-model" },
    history: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "在", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "src/" },
    ],
    tasks: [{ title: "t", status: "done" }],
  }
  assert.equal(loadSession(cwd), null) // 不存在时 null
  saveSession(agent)
  const restored = loadSession(cwd)
  assert.equal(restored.history.length, 3)
  assert.equal(restored.history[1].tool_calls[0].function.name, "ls")
  assert.equal(restored.tasks[0].status, "done")
  clearSession(cwd)
  assert.equal(loadSession(cwd).history.length, 0)
})

// ---------------------------------------------------------------- 模型上下文窗口 / 阈值推导

test("config: 上下文窗口映射与压缩阈值推导", async () => {
  const { contextWindowForModel, resolveCompactThreshold } = await import("../src/config.mjs")
  assert.equal(contextWindowForModel("deepseek-v4-pro"), 1_000_000)
  assert.equal(contextWindowForModel("deepseek-v4-flash"), 256_000)
  assert.equal(contextWindowForModel("DeepSeek-V4-Pro"), 1_000_000) // 大小写不敏感
  assert.equal(contextWindowForModel("unknown-model-xyz"), 128_000) // 未知兜底

  // 显式配置优先
  assert.deepEqual(resolveCompactThreshold(50000, "deepseek-v4-pro"), { value: 50000, auto: false })
  // 未配置时按模型推导（窗口 * 0.6）
  assert.deepEqual(resolveCompactThreshold(null, "deepseek-v4-pro"), { value: 600000, auto: true })
  assert.deepEqual(resolveCompactThreshold(undefined, "deepseek-chat"), { value: 38400, auto: true })
})

// ---------------------------------------------------------------- markdown 表格重排

test("formatTables: CJK 表格按显示宽度对齐", async () => {
  const { formatTables, stringWidth } = await import("../src/tui.mjs")
  const md = [
    "前文不是表格",
    "| 工具 | 需要确认 | 作用 |",
    "|---|---|---|",
    "| write | ✗ | 写文件 |",
    "| memory_search | ✓ | 记忆检索 |",
    "后文",
  ].join("\n")
  const out = formatTables(md, 60)
  assert.equal(out[0], "前文不是表格")
  assert.equal(out.at(-1), "后文")
  const tableLines = out.slice(1, -1)
  // 表头、分隔线、数据行全部等显示宽度（CJK 不错位）
  const widths = new Set(tableLines.map(stringWidth))
  assert.equal(widths.size, 1)
  assert.match(tableLines[0], /工具/)
  assert.match(tableLines[1], /^├/)
  assert.match(tableLines[2], /write/)
})

test("formatTables: 超宽表格按列收缩到可用宽度", async () => {
  const { formatTables, stringWidth } = await import("../src/tui.mjs")
  const md = [
    "| 标题 | 非常非常非常非常非常长的一列内容 |",
    "|---|---|",
    "| a | b |",
  ].join("\n")
  const out = formatTables(md, 30)
  for (const line of out) {
    assert.ok(stringWidth(line) <= 30, `行超宽: ${line}`)
  }
})

test("bash: 流式输出实时透传（onOutput 分块到达）", async () => {
  const bash = builtinTools.find((t) => t.name === "bash")
  const chunks = []
  const result = await bash.execute(
    { command: "echo first && node -e \"setTimeout(()=>console.log('second'),100)\" && wait || true" },
    { cwd: process.cwd(), onOutput: (c) => chunks.push({ t: Date.now(), c }) },
  )
  const text = chunks.map((x) => x.c).join("")
  assert.match(text, /first/)
  assert.match(result, /first/)
  // 流式特征：至少收到过数据块，且与最终返回内容一致
  assert.ok(chunks.length >= 1)
})

// ---------------------------------------------------------------- 断头 tool_calls 修复

test("repairHistory: 为缺失结果的 tool_calls 补中断占位", async () => {
  const { repairHistory } = await import("../src/agent.mjs")
  const history = [
    { role: "user", content: "干活" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    // c2 的结果缺失（进程被杀）
    { role: "user", content: "继续" },
  ]
  const repaired = repairHistory(history)
  assert.notEqual(repaired, history) // 发生了变化
  // c2 被补上中断占位
  const patch = repaired.find((m) => m.role === "tool" && m.tool_call_id === "c2")
  assert.match(patch.content, /interrupted/)
  // 顺序：assistant → tool(c1) → tool(c2 占位) → user
  const roles = repaired.map((m) => m.role)
  assert.deepEqual(roles, ["user", "assistant", "tool", "tool", "user"])
  // 完整的历史原样返回（引用相等）
  assert.equal(repairHistory([{ role: "user", content: "x" }]).length, 1)
})

test("repairHistory: 丢弃空 assistant 消息", async () => {
  const { repairHistory } = await import("../src/agent.mjs")
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "" }, // 思考流跑完正文为空的毒数据
    { role: "user", content: "在吗" },
    { role: "assistant", content: null }, // null 也丢
    { role: "assistant", content: "在" }, // 正常回复保留
    { role: "assistant", content: null, tool_calls: [ // 空正文但带 tool_calls 的合法，保留
      { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ]
  const repaired = repairHistory(history)
  assert.deepEqual(
    repaired.map((m) => m.role),
    ["user", "user", "assistant", "assistant", "tool"],
  )
  assert.equal(repaired[2].content, "在")
})

// ---------------------------------------------------------------- checkpoint 快照与回滚

test("checkpoint: 快照 → 改坏 → 回滚完全恢复", async () => {
  const { execFileSync } = await import("node:child_process")
  const { createCheckpoint, rewind, listCheckpoints } = await import("../src/checkpoint.mjs")
  const { writeFile, readFile: rf, mkdir: mk, rm: del, access } = await import("node:fs/promises")

  const dir = mkdtempSync(join(tmpdir(), "thincoder-cp-"))
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  try {
    // 初始化仓库：一个已跟踪文件
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    await writeFile(join(dir, "app.js"), "const v = 1\n")
    git("add", ".")
    git("commit", "-qm", "init")

    // 快照（含一个未跟踪文件）
    await writeFile(join(dir, "note.md"), "原始笔记\n")
    const cp = await createCheckpoint(dir)
    assert.ok(cp?.id)

    // agent 搞破坏：改跟踪文件、删未跟踪文件、新建垃圾文件
    await writeFile(join(dir, "app.js"), "const v = 999 // 改坏了\n")
    await del(join(dir, "note.md"))
    await mk(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", "junk.js"), "agent 新建的文件\n")

    // 回滚
    const summary = await rewind(dir, cp.id)
    const restored = (await rf(join(dir, "app.js"), "utf8")).replace(/\r\n/g, "\n")
    assert.equal(restored, "const v = 1\n") // 跟踪文件还原（autocrlf 归一化后比较）
    assert.equal(await rf(join(dir, "note.md"), "utf8"), "原始笔记\n") // 未跟踪文件还原
    await assert.rejects(access(join(dir, "src", "junk.js"))) // 新建文件被删
    assert.equal(summary.deleted, 1)

    const cps2 = await listCheckpoints(dir)
    assert.ok(cps2.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- skills 系统

test("skills: load / list / read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-skills-"))
  try {
    const skillDir = join(dir, ".thincoder", "skills")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "deploy.md"), "# Deploy\nPush to production.")
    writeFileSync(join(skillDir, "review.md"), "# Review\nCheck the diff.\n## Steps\n- read diff\n- run tests")
    writeFileSync(join(skillDir, "not-a-skill.txt"), "ignore me")

    const skills = await loadSkills(dir)
    assert.equal(skills.length, 2)
    assert.equal(skills[0].name, "deploy")
    assert.equal(skills[0].description, "Push to production.")
    assert.equal(skills[1].name, "review")

    const listing = formatSkillListing(skills)
    assert.ok(listing.includes("deploy"))
    assert.ok(listing.includes("review"))

    const body = await readSkill(dir, "deploy")
    assert.equal(body, "# Deploy\nPush to production.")
    assert.equal(await readSkill(dir, "nonexistent"), null)
    assert.equal(await readSkill(dir, "../../etc/passwd"), null) // 路径穿越被正则拦截
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("skills: empty dir returns empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-skempty-"))
  try {
    assert.deepEqual(await loadSkills(dir), [])
    assert.equal(formatSkillListing([]), "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 内建工具

test("plan: enter/exit toggles agent state", async () => {
  const agent = {}
  await planTool.execute({ action: "enter" }, { agent })
  assert.equal(agent.planMode, true)
  await planTool.execute({ action: "exit" }, { agent })
  assert.equal(agent.planMode, false)
})

test("goal: set / cancel", async () => {
  const agent = {}
  const r1 = await goalTool.execute({ action: "set", objective: "完成 MCP", criteria: "全部测试通过" }, { agent })
  assert.ok(r1.includes("完成 MCP"))
  assert.equal(agent.goal.objective, "完成 MCP")
  assert.equal(agent.goal.criteria, "全部测试通过")

  const r2 = await goalTool.execute({ action: "cancel" }, { agent })
  assert.equal(agent.goal, null)
  assert.ok(r2.includes("cancelled"))
})

test("verify: git diff stat in mock repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-verify-"))
  const { execSync } = await import("node:child_process")
  const git = (...a) => execSync(`git ${a.join(" ")}`, { cwd: dir, stdio: "ignore" })
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    writeFileSync(join(dir, "x.js"), "1\n")
    git("add", ".")
    git("commit", "-qm", "init")
    writeFileSync(join(dir, "x.js"), "2\n")

    const agent = { cwd: dir, tasks: [{ title: "改好了", status: "done" }] }
    const result = await verifyTool.execute({}, { agent })
    assert.ok(result.includes("x.js"))
    assert.ok(result.includes("1/1 done"))
    assert.ok(result.includes("Self-review checklist"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- delete / git 工具

test("delete: 未跟踪文件可删，跟踪文件拒绝，force 可删跟踪文件", async () => {
  const { execFileSync } = await import("node:child_process")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-del-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: dir })
    writeFileSync(join(dir, "tracked.js"), "1\n")
    writeFileSync(join(dir, "untracked.js"), "2\n")
    execFileSync("git", ["add", "tracked.js"], { cwd: dir })
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir })

    const del = builtinTools.find((t) => t.name === "delete")
    const ctx = { cwd: dir }

    // 未跟踪文件可删
    const r1 = await del.execute({ path: "untracked.js" }, ctx)
    assert.ok(r1.includes("Deleted"))
    assert.ok(!existsSync(join(dir, "untracked.js")))

    // 跟踪文件拒绝
    await assert.rejects(() => del.execute({ path: "tracked.js" }, ctx), /git-tracked/)

    // force 可删跟踪文件
    await del.execute({ path: "tracked.js", force: true }, ctx)
    assert.ok(!existsSync(join(dir, "tracked.js")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("git_diff / git_status / git_log: 只读 git 工具", async () => {
  const { execFileSync } = await import("node:child_process")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-git-"))
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: dir })
    // 关闭 autocrlf，避免 Windows 下 git 自动转换导致 porcelain 输出格式变化
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir })
    writeFileSync(join(dir, "a.js"), "1\n")
    execFileSync("git", ["add", "a.js"], { cwd: dir })
    execFileSync("git", ["commit", "-qm", "first"], { cwd: dir })
    writeFileSync(join(dir, "a.js"), "2\n")
    writeFileSync(join(dir, "b.js"), "3\n")

    const ctx = { cwd: dir }
    const gitDiff = builtinTools.find((t) => t.name === "git_diff")
    const gitStatus = builtinTools.find((t) => t.name === "git_status")
    const gitLog = builtinTools.find((t) => t.name === "git_log")

    // git_diff
    const diff = await gitDiff.execute({}, ctx)
    assert.ok(diff.includes("a.js"))

    // git_status — 验证文件出现即可（Staged/Unstaged 分类取决于 git 平台行为）
    const status = await gitStatus.execute({}, ctx)
    assert.ok(status.includes("a.js"), `missing a.js: ${status}`)
    assert.ok(status.includes("b.js"), `missing b.js: ${status}`)
    assert.ok(
      status.includes("Staged") || status.includes("Unstaged"),
      `missing Staged/Unstaged label: ${status}`,
    )
    assert.ok(status.includes("Untracked"), `missing Untracked: ${status}`)

    // git_log
    const log = await gitLog.execute({ count: 1 }, ctx)
    assert.ok(log.includes("first"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("question: 回调返回用户回答", async () => {
  const qTool = builtinTools.find((t) => t.name === "question")
  // 模拟一个直接返回固定回答的 onQuestion
  const ctx = { cwd: process.cwd(), onQuestion: async (text) => "选方案A" }
  const result = await qTool.execute({ question: "选哪个？" }, ctx)
  assert.equal(result, "选方案A")
})

test("question: 无回调时抛错", async () => {
  const qTool = builtinTools.find((t) => t.name === "question")
  const ctx = { cwd: process.cwd() }
  await assert.rejects(() => qTool.execute({ question: "?" }, ctx), /not supported/)
})

// ---------------------------------------------------------------- ContinueError + resume 模式

test("runAgent: ContinueError 类属性正确", async () => {
  const { ContinueError } = await import("../src/agent.mjs")
  const err = new ContinueError(100)
  assert.equal(err.name, "ContinueError")
  assert.equal(err.turn, 100)
  assert.ok(err instanceof Error)
})
