# 记忆系统设计（thincoder/src/memory/）

> 状态：2026-08 回补。三层记忆（个人/项目/团队）+ 代码/文档向量索引，`node:sqlite` 单文件存储（零依赖）。

## 1. 存储与分层

- **DB**：`~/.thincoder/memory.db`（`node:sqlite`，FTS5 虚表，BM25 排序，schema 版本 9，busy timeout 3s）
- **三层**（写入时指定 layer）：
  - `personal`：个人记忆（`~/.thincoder/memory/` 目录 + DB）
  - `project`：项目共享（`{cwd}/.thincoder/memory/` 目录，markdown 文件为源，DB 索引）
  - `team`：团队层（git 仓库同步，`gitmem.mjs`——提交/拉取记忆文件）
- **条目类型**：`rule | knowledge | decision | pattern`（四类，检索/展示区分）
- **项目层 = markdown 文件即真相**：`putMarkdown` 写文件（frontmatter：type/title/tags），`syncDir` 扫描目录增量入 DB（按 mtime）——文件可人工编辑、可 git 管理，DB 只是索引。

## 2. 检索（core.mjs search）

```
search(memory, query, { limit })
  → 双路召回：
      FTS5（buildFtsQuery：CJK 按字符分段 + 空格分词，BM25）
      + 向量（ensureEmbeddings 懒构建后余弦 top-k）
  → 合并去重（FTS 优先，向量补齐）
```

- `segmentCJK(text)`：中文按单字分段（FTS5 对 CJK 无分词器，单字索引保证召回）
- `ensureEmbeddings`：懒触发——首次检索时批量嵌入存量条目（`EMBED_TEXT_MAX_LEN=2000`），增量条目单独嵌入；嵌入失败静默降级纯 FTS（不阻塞检索）
- 嵌入模型：OpenAI 兼容 `/v1/embeddings`（`embedding.mjs createEmbedder`；bge-m3 是既定选择）；向量存 `vectors` 表 blob，`cosine` 相似度

## 3. 代码/文档索引（code-index / code-sync / docs）

**存储**：`{cwd}/.thincoder/index/`——`manifest.json`（版本/嵌入模型/已索引 commit/文件→chunk 映射）+ `vectors.bin`（dim+count+offsets+原始 Float32 向量）。

**同步策略**（code-sync.mjs）：
- **git 增量优先**：`gitSync` 用 `git diff --name-status` 找改动文件（比全扫快一个量级）；非 git 仓库/首次回退全量扫描（`listProjectFiles` 按扩展名，跳过 node_modules/.git/dist 等）
- `codeSync`：全量扫描 → 逐文件 `_upsertCodeFile`（按 mtime 跳过未变文件）→ `markIndexedCommit` 记录基线
- **单文件增量**：`reindexFile(memory, cwd, absPath)`——write/edit/delete 工具执行后由主循环调用（agent.mjs 挂钩），mtime 变更才重建 chunk

**代码分块**（code-index.mjs）：按函数/类/export 边界切块（`chunkCode`，≤30 行、3 行重叠；`detectLanguage` + 语言专属符号提取——JS/Py 等）；doc 按 `##` 标题或空行切块（≤20 行）。每块带 `{idx, startLine, endLine}` 定位。

**检索**（`codeSearch` / `docSearch`）：`{kind: code|doc|memory}` 限定——FTS 候选 + 向量重排，返回 `{file, startLine, endLine, snippet, score}`。暴露为工具：`code_search`（codeSearchTool）/ `doc_search`（docSearchTool）/ `memory_search` / `memory_put`（memoryTools）。

**doc 同步**（docs.mjs docSync）：扫描 `docs/`、`*.md`、AGENTS.md 等 → 分块 → FTS+向量；`doc_search` 在 agent 循环里按用户输入关键词匹配 chunk 注入（见 AGENT-LOOP.md §3）。

## 4. 主循环集成

- 记忆工具（memory_put/memory_search）供 agent 自主存取；`search` 结果注入 system 上下文（`<untrusted_memory>` 包裹）
- **`put` 自动嵌入选块**：新条目写 DB 后若嵌入器可用，异步补向量（不阻塞写入）
- 目录/条目变更后由 `reindexFile` 增量刷新代码索引（后台，失败注入提醒不阻塞）

## 5. 关键设计决策

| 决策 | 理由 |
|---|---|
| 文件即真相（项目层） | 人工可读可改、可 git 管理；DB 只是可重建的索引（syncDir 幂等） |
| FTS5 + 向量双路召回 | 纯 FTS 对语义近义召回差；纯向量对精确术语差；合并互补 |
| 嵌入懒构建 + 失败降级 | 无 key 也能用（纯 FTS）；首次检索延迟可接受 |
| CJK 单字分段 | FTS5 无中文分词器；单字索引保召回（BM25 排序仍合理） |
| git diff 增量同步 | 大仓库全扫太慢；diff 只处理改动文件 |
| schema 版本迁移 | node:sqlite 迁移脚本按版本号递进，破坏性变更显式处理 |
