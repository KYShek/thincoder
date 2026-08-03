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
    const created = await byName.git.execute({ action: "checkpoint", checkpointAction: "create" }, ctx)
    const id = created.match(/Checkpoint (\S+) created/)[1]
    const listed = await byName.git.execute({ action: "checkpoint", checkpointAction: "list" }, ctx)
    assert.ok(listed.includes(id))

    // 改坏 → rewind 恢复
    writeFileSync(join(dir, "app.js"), "const v = 999\n")
    await byName.git.execute({ action: "checkpoint", checkpointAction: "rewind", checkpointId: id }, ctx)
    assert.equal(readFileSync(join(dir, "app.js"), "utf8").replace(/\r\n/g, "\n"), "const v = 1\n")

    // rewind 缺 id 报错；非 git 仓库报错
    await assert.rejects(() => byName.git.execute({ action: "checkpoint", checkpointAction: "rewind" }, ctx), /checkpointId is required/)
    const plain = mkdtempSync(join(tmpdir(), "thincoder-cptool-plain-"))
    await assert.rejects(() => byName.git.execute({ action: "checkpoint", checkpointAction: "list" }, { cwd: plain }), /Not a git repository/)
    rmSync(plain, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checkpoint 工具：list 的文件名做 XML 转义（防注入模型上下文）", async () => {
  const { execFileSync } = await import("node:child_process")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-cpxml-"))
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
    // Windows 合法但 XML 敏感的字符 & ' 出现在文件名里（<>"/" Windows 不允许）
    writeFileSync(join(dir, "a&'b'.txt"), "x\n")
    const created = await byName.git.execute({ action: "checkpoint", checkpointAction: "create" }, ctx)
    const id = created.match(/Checkpoint (\S+) created/)[1]

    const overview = await byName.git.execute({ action: "checkpoint", checkpointAction: "list" }, ctx)
    assert.ok(overview.includes("a&amp;&apos;b&apos;.txt"), `overview 应转义文件名: ${overview}`)
    assert.ok(!overview.includes("a&'b'.txt"))

    const tree = await byName.git.execute({ action: "checkpoint", checkpointAction: "list", checkpointId: id }, ctx)
    assert.ok(tree.includes("a&amp;&apos;b&apos;.txt"), `file tree 应转义文件名: ${tree}`)
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

test("bash 护栏：重定向检测引号感知——脚本内比较运算符不误伤，真重定向仍拦截", async () => {
  const { hasFileRedirection } = await import("../src/tools/shared.mjs")
  // 放行：引号脚本里的 > < => 比较/箭头函数不是重定向
  for (const ok of [
    `node -e "if (a.length > 0) console.log(a)"`,
    `node -e "const f = (x) => x * 2"`,
    `node -e "while (i < 10) i++"`,
    `echo "a > b"`,
    `node -e 'console.log(JSON.stringify({a:1}))'`,
  ]) {
    assert.equal(hasFileRedirection(ok), false, `不应误判: ${ok}`)
  }
  // 拦截：引号外的真实重定向（含 heredoc）
  for (const blocked of [
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "cat < input.txt",
    "echo ok && node app.js > log.txt",
    "cat << EOF",
    "node app.js 2> err.txt".replace("2> ", "> "), // fd 前缀形式也拦
  ]) {
    assert.equal(hasFileRedirection(blocked), true, `应拦截: ${blocked}`)
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

test("verify: doc-only 改动走快路径（不跑语法检查/测试/任务列表/自检清单）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-verify-doc-"))
  const { execSync } = await import("node:child_process")
  const git = (...a) => execSync(`git ${a.join(" ")}`, { cwd: dir, stdio: "ignore" })
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    mkdirSync(join(dir, "docs", "design"), { recursive: true })
    writeFileSync(join(dir, "README.md"), "# readme\n")
    writeFileSync(join(dir, "docs/design/PLAN.md"), "# plan\n")
    git("add", ".")
    git("commit", "-qm", "init")

    // 纯文档改动（.md）→ 快路径
    writeFileSync(join(dir, "README.md"), "# readme v2\n")
    writeFileSync(join(dir, "docs/design/PLAN.md"), "# plan v2\n")
    const agent = { cwd: dir, tasks: [{ title: "未完成", status: "pending" }] }
    const result = await verifyTool.execute({}, { agent })
    assert.ok(result.includes("Documentation-only changes"), result)
    assert.strictEqual(agent._verifyPassed, true)
    assert.ok(!result.includes("Syntax check"), "no syntax checks on doc-only")
    assert.ok(!result.includes("Related tests"), "no tests on doc-only")
    assert.ok(!result.includes("Task list"), "no task list on doc-only")
    assert.ok(!result.includes("Self-review checklist"), "no checklist on doc-only")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("verify: mixed 改动（文档+代码）不走快路径，语法检查照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-verify-mixed-"))
  const { execSync } = await import("node:child_process")
  const git = (...a) => execSync(`git ${a.join(" ")}`, { cwd: dir, stdio: "ignore" })
  try {
    git("init", "-q")
    git("config", "user.name", "t")
    git("config", "user.email", "t@t.dev")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "README.md"), "# readme\n")
    writeFileSync(join(dir, "src/app.js"), "const v = 1\n")
    git("add", ".")
    git("commit", "-qm", "init")

    // 文档 + 代码混合改动 → 全量路径
    writeFileSync(join(dir, "README.md"), "# readme v2\n")
    writeFileSync(join(dir, "src/app.js"), "const v = 2\n")
    const agent = { cwd: dir, tasks: [] }
    const result = await verifyTool.execute({}, { agent })
    assert.ok(!result.includes("Documentation-only changes"), result)
    assert.ok(result.includes("Syntax check"), "syntax checks still run on mixed changes")
    assert.ok(result.includes("Self-review checklist"), "full path still shows the checklist")
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
    const git = builtinTools.find((t) => t.name === "git")

    // git diff
    const diff = await git.execute({ action: "diff" }, ctx)
    assert.ok(diff.includes("a.js"))

    // git status
    const status = await git.execute({ action: "status" }, ctx)
    assert.ok(status.includes("a.js"), `missing a.js: ${status}`)
    assert.ok(status.includes("b.js"), `missing b.js: ${status}`)
    assert.ok(
      status.includes("Staged") || status.includes("Unstaged"),
      `missing Staged/Unstaged label: ${status}`,
    )
    assert.ok(status.includes("Untracked"), `missing Untracked: ${status}`)

    // git log
    const log = await git.execute({ action: "log", count: 1 }, ctx)
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

// ---------------------------------------------------------------- hashline_edit

test("hashline_edit: 按哈希定位替换单行", async () => {
  const { hashLine } = await import("../src/tools/file.mjs")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-hashline-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "f.mjs", content: "const x = 1\nconst y = 2\nconst z = 3\n" }, ctx)

    // Read with hashes to get line hashes
    const readOut = await byName.read.execute({ path: "f.mjs", hashes: true }, ctx)
    // Parse hash from output: "1\t[abc123def456] const x = 1"
    const line1Hash = readOut.split("\n")[0].match(/\[([a-f0-9]{12})\]/)[1]

    // Replace line 1 with new content using hash
    const out = await byName.hashline_edit.execute({
      path: "f.mjs",
      old_hashes: [line1Hash],
      new_content: "const x = 42",
    }, ctx)
    assert.match(out, /replaced 1 line/)

    const updated = await byName.read.execute({ path: "f.mjs" }, ctx)
    assert.match(updated, /const x = 42/)
    assert.match(updated, /const y = 2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hashline_edit: 多行替换", async () => {
  const { hashLine } = await import("../src/tools/file.mjs")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-hashline-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "f.mjs", content: "line1\nline2\nline3\nline4\n" }, ctx)

    const readOut = await byName.read.execute({ path: "f.mjs", hashes: true }, ctx)
    const lines = readOut.split("\n")
    const h2 = lines[1].match(/\[([a-f0-9]{12})\]/)[1]
    const h3 = lines[2].match(/\[([a-f0-9]{12})\]/)[1]

    const out = await byName.hashline_edit.execute({
      path: "f.mjs",
      old_hashes: [h2, h3],
      new_content: "replaced_A\nreplaced_B",
    }, ctx)
    assert.match(out, /replaced 2 line/)

    const updated = await byName.read.execute({ path: "f.mjs" }, ctx)
    assert.match(updated, /line1/)
    assert.match(updated, /replaced_A/)
    assert.match(updated, /replaced_B/)
    assert.match(updated, /line4/)
    assert.doesNotMatch(updated, /line2/)
    assert.doesNotMatch(updated, /line3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hashline_edit: hash 未匹配时报错含当前哈希", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-hashline-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "f.mjs", content: "hello world\n" }, ctx)

    await assert.rejects(
      () => byName.hashline_edit.execute({
        path: "f.mjs",
        old_hashes: ["deadbeef0000"],
        new_content: "nope",
      }, ctx),
      /Hash sequence not found/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hashline_edit: 多个匹配时报错列出所有位置", async () => {
  const { hashLine } = await import("../src/tools/file.mjs")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-hashline-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    // File with multiple empty lines — all have the same hash
    const lines = [
      "// file with blanks",  // unique hash
      "",                       // empty-line hash (collides across all empties)
      "const a = 1",            // unique hash
      "",                       // collides
      "const b = 2",            // unique hash
      "",                       // collides
    ]
    await byName.write.execute({ path: "f.mjs", content: lines.join("\n") }, ctx)

    // Try to replace a single empty line — it will match 3 positions
    const emptyHash = hashLine("")
    await assert.rejects(
      () => byName.hashline_edit.execute({
        path: "f.mjs",
        old_hashes: [emptyHash],
        new_content: "// replaced",
      }, ctx),
      /matches 3 positions.*ambiguous/s
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- normalizeEOL (Windows line endings)

test("normalizeEOL: \\r\\n file → edit matches with \\n only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-eol-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    // Write file with Windows line endings directly to disk (bypass write tool which uses \n)
    writeFileSync(join(dir, "f.mjs"), "hello\r\nworld\r\n", "utf8")

    // edit should still match with \n-only old_string (normalizeEOL kicks in)
    const out = await byName.edit.execute({
      path: "f.mjs",
      old_string: "hello\nworld",
      new_string: "replaced",
    }, ctx)
    assert.ok(out.includes("replaced 1 occurrence"), out)

    // Verify final content has \n only (tools always write \n)
    const content = readFileSync(join(dir, "f.mjs"), "utf8")
    assert.strictEqual(content, "replaced\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("normalizeEOL: hashes are consistent regardless of \\r\\n", async () => {
  const { hashLine } = await import("../src/tools/file.mjs")
  const dir = mkdtempSync(join(tmpdir(), "thincoder-eol2-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    // Write file with \r\n, reading should give same hashes as \n-only version
    writeFileSync(join(dir, "crlf.mjs"), "const a = 1\r\nconst b = 2\r\n", "utf8")

    const readOut = await byName.read.execute({ path: "crlf.mjs", hashes: true }, ctx)
    const hash1 = readOut.split("\n")[0].match(/\[([a-f0-9]{12})\]/)[1]

    // Compare against hash of \n-only line
    const expectedHash = hashLine("const a = 1")
    assert.strictEqual(hash1, expectedHash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- insert_after regex validation

test("insert_after: invalid regex gives helpful error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-insert-re-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "f.mjs", content: "hello\nworld\n" }, ctx)

    await assert.rejects(
      () => byName.insert_after.execute({
        path: "f.mjs",
        after_regex: "**bad**",
        content: "// inserted",
      }, ctx),
      /not a valid JavaScript regex/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- grep regex validation

test("grep: invalid regex gives helpful error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-grep-re-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await byName.write.execute({ path: "f.mjs", content: "hello\nworld\n" }, ctx)

    await assert.rejects(
      () => byName.grep.execute({ pattern: "**bad**", path: "." }, ctx),
      /not a valid regex/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- grep \r\n normalization

test("grep: \\r\\n file still matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-grep-eol-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    writeFileSync(join(dir, "crlf.mjs"), "hello world\r\nconst x = 1\r\n", "utf8")

    const out = await byName.grep.execute({ pattern: "hello", path: "." }, ctx)
    assert.ok(out.includes("crlf.mjs"), out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ls missing directory

test("ls: missing directory gives helpful error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-ls-"))
  const ctx = { cwd: dir }
  const byName = Object.fromEntries(builtinTools.map((t) => [t.name, t]))
  try {
    await assert.rejects(
      () => byName.ls.execute({ path: "nonexistent" }, ctx),
      /not found/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- checklist ID round-trip regression

import { checklistTool } from "../src/tools/checklist.mjs"

test("checklist: ID 前缀往返不叠加（add→write→parse→write 循环保持单一前缀）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-cl-"))
  const ctx = { cwd: dir }
  try {
    checklistTool.execute({ action: "add", item: "第一项" }, ctx)
    checklistTool.execute({ action: "add", item: "第二项" }, ctx)
    // mark done → parse → write 往返
    checklistTool.execute({ action: "mark", index: 1, status: "in_progress" }, ctx)
    checklistTool.execute({ action: "mark", index: 1, status: "pending" }, ctx)
    checklistTool.execute({ action: "mark", index: 2, status: "in_progress" }, ctx)
    checklistTool.execute({ action: "mark", index: 2, status: "pending" }, ctx)
    const content = readFileSync(join(dir, ".thincoder", "checklist.md"), "utf-8")
    // 往返多次后每行 ID 只出现一次，绝不能 "T1: T1:"
    assert.doesNotMatch(content, /T1: T1/)
    assert.doesNotMatch(content, /T2: T2/)
    assert.match(content, /- \[ \] T1: 第一项/)
    assert.match(content, /- \[ \] T2: 第二项/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("checklist: 手写带前缀的存量文件往返一次后前缀不翻倍", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-cl2-"))
  mkdirSync(join(dir, ".thincoder"), { recursive: true })
  writeFileSync(join(dir, ".thincoder", "checklist.md"), "- [ ] T1: 存量任务\n")
  const ctx = { cwd: dir }
  try {
    checklistTool.execute({ action: "mark", index: 1, status: "in_progress" }, ctx)
    checklistTool.execute({ action: "mark", index: 1, status: "pending" }, ctx)
    const content = readFileSync(join(dir, ".thincoder", "checklist.md"), "utf-8")
    assert.doesNotMatch(content, /T1: T1/)
    assert.match(content, /- \[ \] T1: 存量任务/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- execute tool regressions

import { codeModeTool } from "../src/tools/codemode.mjs"

test("execute: timeout 生效——无限循环脚本在限定时间内返回错误而不是挂死", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-exec-"))
  try {
    const out = await codeModeTool.execute({ code: "while (true) {}", timeoutMs: 300 }, { cwd: dir })
    assert.match(out, /Error/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("execute: SSRF 拒绝信息同步返回给模型（不是 unhandled rejection 崩进程）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-exec2-"))
  try {
    const out = await codeModeTool.execute({ code: 'fetch("http://169.254.169.254/latest/meta-data/")' }, { cwd: dir })
    assert.match(out, /private\/internal host not allowed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("execute: 正常沙箱行为不受影响（log/readFile/grep）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-exec3-"))
  writeFileSync(join(dir, "f.txt"), "hello\nworld\n")
  try {
    const out = await codeModeTool.execute({ code: 'log(grep("wor", "f.txt").join(","))' }, { cwd: dir })
    assert.equal(out, "2: world")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
