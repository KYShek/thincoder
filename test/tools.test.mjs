/**
 * 工具测试（tools / skills / distill / plan / goal / verify / delete / git / checkpoint）。
 * 从 test/units.test.mjs 提取。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"

import { builtinTools } from "../src/tools/index.mjs"
import { createMemory } from "../src/memory.mjs"
import { loadSkills, formatSkillListing, readSkill } from "../src/skills.mjs"
import { historyToTranscript, saveCandidate } from "../src/distill.mjs"
import { planTool, goalTool, verifyTool } from "../src/agent-tools.mjs"

function freshMemory() {
  return createMemory({ dbPath: ":memory:" })
}

// ---------------------------------------------------------------- tools

test("read_image: 非视觉模型直接拒绝（防 image_url 毒化会话），视觉模型正常返回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-test-"))
  try {
    // 1x1 透明 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
    writeFileSync(join(dir, "a.png"), png)
    const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
    // DeepSeek（无视觉）：读文件前就拒绝，错误信息说明原因与替代方案
    await assert.rejects(
      () => byName.read_image.execute({ path: "a.png" }, { cwd: dir, agent: { provider: { model: "deepseek-v4-pro" } } }),
      /does not support image input/,
    )
    // Kimi K3（有视觉）：正常返回 { text, images }
    const out = await byName.read_image.execute({ path: "a.png" }, { cwd: dir, agent: { provider: { model: "kimi-k3" } } })
    const parsed = JSON.parse(out)
    assert.match(parsed.text, /read_image: a\.png/)
    assert.equal(parsed.images[0].type, "image_url")
    // 无 agent 上下文（独立调用）：不拦截
    const out2 = await byName.read_image.execute({ path: "a.png" }, { cwd: dir })
    assert.equal(JSON.parse(out2).images.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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


test("globToRegex: **跨目录 / * 段内 / ? 单字符 / 精确匹配", async () => {
  const { globToRegex } = await import("../src/tools/shared.mjs")
  // **/*.txt：匹配任意深度的 .txt 文件（含根目录、多层子目录）
  const re1 = globToRegex("**/*.txt")
  assert.ok(re1.test("a.txt"), "**/*.txt should match root file")
  assert.ok(re1.test("sub/a.txt"), "**/*.txt should match one-level deep")
  assert.ok(re1.test("deep/nested/a.txt"), "**/*.txt should match multi-level deep")
  assert.ok(!re1.test("a.txt.bak"), "**/*.txt should not match wrong extension")

  // ** 单独使用：匹配任意路径（跨目录）
  const re2 = globToRegex("src/**")
  assert.ok(re2.test("src/a.mjs"), "src/** should match file in src/")
  assert.ok(re2.test("src/deep/nested/a.mjs"), "src/** should match deeply nested file")
  assert.ok(!re2.test("test/a.mjs"), "src/** should not match outside src/")

  // * 段内通配（不跨 /）
  const re3 = globToRegex("*.mjs")
  assert.ok(re3.test("a.mjs"), "*.mjs should match root file")
  assert.ok(!re3.test("sub/a.mjs"), "*.mjs should not match subdirectory file")

  // ? 单字符
  const re4 = globToRegex("a?.mjs")
  assert.ok(re4.test("ab.mjs"), "a?.mjs should match ab.mjs")
  assert.ok(!re4.test("abc.mjs"), "a?.mjs should not match abc.mjs")

  // 精确匹配
  const re5 = globToRegex("exact.mjs")
  assert.ok(re5.test("exact.mjs"), "exact match")
  assert.ok(!re5.test("notexact.mjs"), "no false positive")
})

test("tools: apply_patch 多文件原子应用 / 新建文件 / 失败不落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-patch-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
    writeFileSync(join(dir, "b.txt"), "alpha\nbeta\ngamma\n")

    // 一个补丁改两个文件 + 建一个新文件
    const patch = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,3 +1,4 @@",
      " alpha",
      "+inserted",
      " beta",
      " gamma",
      "--- /dev/null",
      "+++ b/sub/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n")
    const out = await byName.apply_patch.execute({ patch }, ctx)
    assert.match(out, /3 file/)
    assert.strictEqual(readFileSync(join(dir, "a.txt"), "utf8"), "one\nTWO\nthree\n")
    assert.strictEqual(readFileSync(join(dir, "b.txt"), "utf8"), "alpha\ninserted\nbeta\ngamma\n")
    assert.strictEqual(readFileSync(join(dir, "sub", "new.txt"), "utf8"), "hello\nworld\n")

    // touchedPaths 供 agent 层追踪
    assert.deepStrictEqual(byName.apply_patch.touchedPaths({ patch }), ["a.txt", "b.txt", "sub/new.txt"])

    // 原子性：第二个文件 hunk 不上，第一个文件也不能落盘
    const before = readFileSync(join(dir, "a.txt"), "utf8")
    const bad = [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+ONE",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-no-such-line",
      "+x",
      "",
    ].join("\n")
    await assert.rejects(() => byName.apply_patch.execute({ patch: bad }, ctx), /does not apply/)
    assert.strictEqual(readFileSync(join(dir, "a.txt"), "utf8"), before)

    // 上下文多处匹配 → 拒绝，要求更多上下文
    writeFileSync(join(dir, "dup.txt"), "x\ny\nx\ny\n")
    const ambiguous = ["--- a/dup.txt", "+++ b/dup.txt", "@@ -1,2 +1,2 @@", " x", "-y", "+z", ""].join("\n")
    await assert.rejects(() => byName.apply_patch.execute({ patch: ambiguous }, ctx), /matches \d+ locations/)

    // 路径越界拒绝
    const escape = ["--- a/../evil.txt", "+++ b/../evil.txt", "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n")
    await assert.rejects(() => byName.apply_patch.execute({ patch: escape }, ctx), /Access denied/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tools: grep before/after 上下文行（匹配行 : 上下文行 -，相邻区间合并）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-grep-ctx-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    // 两处匹配相邻（line2 / line4），before=1 after=1 → line3 同时是 line2 的 after 与 line4 的 before，应去重合并
    await byName.write.execute({
      path: "c.txt",
      content: "alpha\nMATCH one\nmid\nMATCH two\nomega\n",
    }, ctx)

    // 无上下文：仍是 path:line: content，不出现 -N- 上下文分隔
    const plain = await byName.grep.execute({ pattern: "MATCH", path: "c.txt" }, ctx)
    assert.match(plain, /c\.txt:2: MATCH one/)
    assert.match(plain, /c\.txt:4: MATCH two/)
    assert.doesNotMatch(plain, /c\.txt-\d+-/)

    // before=1 after=1：匹配行用 ':'，上下文行用 '-'，line3 只出现一次
    const ctxOut = await byName.grep.execute({ pattern: "MATCH", path: "c.txt", before: 1, after: 1 }, ctx)
    const lines = ctxOut.split("\n")
    // 顺序：c-1- alpha / c:2: MATCH one / c-3- mid / c:4: MATCH two / c-5- omega
    assert.equal(lines.length, 5)
    assert.match(lines[0], /c\.txt-1- alpha/)
    assert.match(lines[1], /c\.txt:2: MATCH one/)
    assert.match(lines[2], /c\.txt-3- mid/)        // line3 合并去重，只一行
    assert.match(lines[3], /c\.txt:4: MATCH two/)
    assert.match(lines[4], /c\.txt-5- omega/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- websearch / ls / fetch

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

// ---------------------------------------------------------------- bash 流式

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

// ---------------------------------------------------------------- checkpoint 快照与回滚

test("checkpoint: 快照 → 改坏 → 回滚完全恢复", async () => {
  const { execFileSync } = await import("node:child_process")
  const { createCheckpoint, rewind, listCheckpoints } = await import("../src/git/checkpoint.mjs")
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

test("checkpoint 工具：list / create / rewind 走工具入口", async () => {
  const { execFileSync } = await import("node:child_process")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-cptool-"))
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  const ctx = { cwd: dir }
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    writeFileSync(join(dir, "app.js"), "const v = 1\n")
    git("add", ".")
    git("commit", "-qm", "init")

    // create → list 能查到
    const created = await byName.checkpoint.execute({ action: "create" }, ctx)
    const id = created.match(/Checkpoint (\S+) created/)[1]
    const listed = await byName.checkpoint.execute({ action: "list" }, ctx)
    assert.ok(listed.includes(id))

    // 改坏 → rewind 恢复
    writeFileSync(join(dir, "app.js"), "const v = 999\n")
    await byName.checkpoint.execute({ action: "rewind", id }, ctx)
    assert.equal(readFileSync(join(dir, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 1\n")

    // rewind 缺 id 报错；非 git 仓库报错
    await assert.rejects(() => byName.checkpoint.execute({ action: "rewind" }, ctx), /id is required/)
    const plain = mkdtempSync(join(tmpdir(), "thincoder-cptool-plain-"))
    await assert.rejects(() => byName.checkpoint.execute({ action: "list" }, { cwd: plain }), /Not a git repository/)
    rmSync(plain, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bash 护栏：checkout ./restore/clean -f/链式写法拦截，安全写法放行", async () => {
  const { execFileSync } = await import("node:child_process")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-guard-"))
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  const ctx = { cwd: dir }
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    writeFileSync(join(dir, "app.js"), "const v = 1\n")
    git("add", ".")
    git("commit", "-qm", "init")
    writeFileSync(join(dir, "app.js"), "const v = 2\n") // 未提交改动 → 护栏生效条件

    // 这些都必须被拒（昨天的事故就是这类命令漏过去的）
    for (const cmd of [
      "git checkout .",
      "git checkout -- app.js",
      "git reset --hard",
      "git restore app.js",
      "git restore .",
      "git clean -fd",
      "echo ok && git checkout .",   // 链式绕过
      "cd . ; git reset --hard HEAD", // 分号链式
    ]) {
      await assert.rejects(() => byName.bash.execute({ command: cmd }, ctx), /Refusing destructive/, cmd)
    }
    // 拒绝时未提交改动原样保留
    assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "const v = 2\n")

    // 安全写法不误伤：切分支（无路径）、restore --staged、clean -n dry-run
    for (const cmd of ["git checkout -b feature-x", "git restore --staged app.js", "git clean -nd"]) {
      await byName.bash.execute({ command: cmd }, ctx)
    }
    git("checkout", "-q", "-") // 回到原分支，清理
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
    writeFileSync(join(skillDir, "lint.md"), "---\nname: lint\n---\n# Lint\nRun the linter.")
    writeFileSync(join(skillDir, "not-a-skill.txt"), "ignore me")

    const skills = await loadSkills(dir)
    assert.equal(skills.length, 3)
    assert.equal(skills[0].name, "deploy")
    assert.equal(skills[0].description, "Push to production.")
    assert.equal(skills[1].name, "lint")
    assert.equal(skills[1].description, "Run the linter.") // frontmatter 字段行不误当描述
    assert.equal(skills[2].name, "review")

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

// ---------------------------------------------------------------- distill

test("distill: saveCandidate tags 归一化（LLM 输出不可信）", async () => {
  const m = freshMemory()
  // 字符串 tags 按逗号/空白切分
  const r1 = await saveCandidate(m, { type: "knowledge", title: "t1", content: "c1", tags: "a, b c" })
  assert.ok(r1.startsWith("personal#"))
  // 非字符串非数组 tags 不崩
  const r2 = await saveCandidate(m, { type: "knowledge", title: "t2", content: "c2", tags: 42 })
  assert.ok(r2.startsWith("personal#"))
})

test("distill: historyToTranscript 容忍缺失 function 的 tool_call", () => {
  const text = historyToTranscript([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: "{}" } }, { id: "broken" }] },
  ])
  assert.ok(text.includes("read("))
  assert.ok(text.includes("?(")) // 缺失 function 的占位不抛 TypeError
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

test("verify: quick 模式下语法失败不能算通过（_verifyPassed=false）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-verify-syn-"))
  const { execSync } = await import("node:child_process")
  const git = (...a) => execSync(`git ${a.join(" ")}`, { cwd: dir, stdio: "ignore" })
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    writeFileSync(join(dir, "x.js"), "1\n")
    git("add", ".")
    git("commit", "-qm", "init")

    // 改出一个语法错误文件 → quick verify 必须标记失败（完成守卫靠这个推回修复）
    writeFileSync(join(dir, "x.js"), "const = 1\n")
    const agent = { cwd: dir, tasks: [] }
    const result = await verifyTool.execute({}, { agent })
    assert.ok(result.includes("syntax error"))
    assert.strictEqual(agent._verifyPassed, false)

    // 修好后 quick verify 通过
    writeFileSync(join(dir, "x.js"), "const v = 1\n")
    await verifyTool.execute({}, { agent })
    assert.strictEqual(agent._verifyPassed, true)
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
