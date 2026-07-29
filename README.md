# ThinCoder

**Sharp Code, Zero Bloat.**

**A "thin" AI coding agent: pure `.mjs`, no build step, zero npm dependencies, native Node.js.**

The "Thin" in ThinCoder doesn't mean "feature-poor" — it means **sharp thinking, straight to the point** — like a blade.
While every AI agent races to be "all-powerful", ThinCoder plays the opposite card: **restraint, precision, no filler**.
Its persona is a geek engineer of few words who cuts to the bone: give it a complex requirement, get back a clean implementation.

Design philosophy (the entire meaning of the name): if the Node standard library can do it, no dependency is allowed. The project's `node_modules` is empty.

## Features

- **Fix-verify loop**: file changes without `verify` get pushed back — syntax check + tests must pass before the agent can claim completion (auto-repair up to 3 rounds)
- **Checkpoint system**: auto-snapshot before every user task, `list`/`create`/`rewind` tools for the model, single-file restore — rewinding itself is reversible (pre-rewind state auto-saved)
- **Codebase understanding** ⭐0.5.0: `repo_outline` (dependency outline, auto-injected at startup), `code_search` (source FTS5 + vectors + JSDoc extraction), `doc_search` (docs chunked by ## headings) — background indexing, auto-incremental updates on file writes, three tools guided by "structure → intent → details"
- **Model adaptation** ⭐: top-tier only, latest only. Built-in flagship models from five leading Chinese vendors — DeepSeek / Kimi / GLM / Qwen / MiniMax. No legacy model compatibility, no local model support. Auto-matched context windows, truncation-resume protocols (prefix/partial), thinking-mode APIs (thinking.type / reasoning_effort), reasoning_content echo strategies (reasoningEcho), output limits, temperature range clamping — all five deeply adapted.
- **Toolset**: `read` / `write` / `edit` / `bash` / `glob` (supports `**`) / `grep` / `websearch` / `ls` / `fetch` + `read_image` (image/video paste) + three retrieval tools + MCP — all zero-dependency, file tools confined to the working directory
- **Memory system**: three layers (personal/project/team), FTS5 + vector RRF hybrid retrieval, git-friendly markdown format
- **Two-phase tool scheduling**: permission prompts serialized, read-only tools parallelized, side-effect tools serialized
- **Session persistence** ⭐0.5.0: up to 5 archive slots, `/session` to switch anytime, tool results visible after restore
- **Concurrent subagents**: three roles — `explore`/`plan`/`coder` — dispatched in parallel, streaming output visible, reports land in the conversation
- **Plan Mode**: read-only exploration + design, implement after user approval
- **AUTO mode**: `/auto` full authorization, no confirmations on long tasks
- **Task tracking**: `task` tool breaks down multi-step work, status bar ✓n/m live progress, auto-filters completed items
- **Goal/Verify/Skills**: long-goal tracking, completion verification, reusable skills
- **Streaming TUI**: bare ANSI, permission preview right above the input box, write/edit auto-shows diffs, paste shortcut hint in the input box corner for multimodal models (Win: Alt+V / Mac/Linux: Ctrl+V)

## Memory: What One Learns, the Whole Team Knows

Three layers, all "query if present, skip if absent", unified hybrid retrieval:

| Layer            | Location                                             | Sync method                                                                                    |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Personal**     | `~/.thincoder/memory.db` (sqlite)                    | Not synced, private                                                                            |
| **Project**      | `.thincoder/memory/*.md` in the project repo         | With the project git (ThinCoder **only writes files, never commits for you**)                  |
| **Team** (opt.)  | Dedicated memory repo, cloned to `~/.thincoder/teams/<name>/` | `thincoder sync` (pull --rebase); auto commit + push on write (dedicated facility, opt-in) |

- **Hybrid retrieval**: FTS5 (BM25, per-character CJK indexing, bigrams matchable) + embedding vectors (brute-force cosine) + RRF(k=60) fusion ranking
- **Embeddings**: OpenAI-compatible `/v1/embeddings`, defaults to SiliconFlow `BAAI/bge-m3` (free tier, good CJK support); Ollama works as an offline option. Vectors generated lazily — not computed on write, backfilled and persisted on first search
- **Entry format**: Markdown + frontmatter (type/title/tags/author/created), readable and reviewable directly on GitHub; one file per entry, naturally avoiding merge conflicts; real conflicts produce honest errors, never auto-merged
- **Dual-track accumulation**: conventions written manually (`memory_put`), experience extracted from sessions via `/extract` — **the LLM proposes candidates, a human confirms each y/n** before anything is stored; never fully automatic
- **Retrieval isolation**: the Project layer is isolated by project path — project A's memories never leak into project B

## Requirements

- Node.js >= 24
- An API key for any OpenAI-compatible endpoint
- Optional: an embedding service key (without it, retrieval degrades to pure FTS)

## Quick Start

```bash
# Install
npm install -g thincoder

# Launch the TUI (default command)
thincoder
```

First launch walks you through a setup wizard: arrow keys to pick a provider (built-in presets or a custom endpoint) → enter API key → optionally enter an embedding key (SiliconFlow, enables vector memory search, skippable) → arrow keys to pick a model — no hand-editing config files. Adjust anytime with `/provider`, `/model`, `/config embedkey`. `chat`/`distill` also offer in-place interactive setup when no key is configured in a terminal (in pipes/CI they exit with an error and instructions).

You can also hand-write `~/.thincoder/config.json` (see "Configuration" below), then:

```bash
# One-shot Q&A (pipe-friendly)
thincoder chat "read package.json and summarize it"

# Memory management
thincoder memory put --type=rule --title="code style" --content="no semicolons"
thincoder memory search "code style"
thincoder memory list
thincoder memory remove 1

# Team memory (optional, available after configuring memory.team)
thincoder sync                       # pull the team repo and rebuild the index

# Extract knowledge from a session transcript (stored after per-item confirmation)
thincoder distill session.txt

# Upgrade
thincoder upgrade
```

Running from source: replace `thincoder` above with `node bin/thincoder.mjs`.

Slash commands in the TUI: `/help`, `/model` (arrow-key picker across all models of all providers; `/model <name>` switches directly), `/provider` (add/remove providers, set keys, custom endpoints), `/think` (thinking mode toggle and reasoning effort), `/config` (view config, `/config embedkey` for the embedding key, `/config set` for parameters), `/session` (list/switch archived sessions), `/reindex` (rebuild the index), `/extract` (extract knowledge from the current session), `/restore` (restore checkpoint), `/clear`, `/exit`. High-frequency commands support abbreviations: `/h` `/x` `/m` `/p` `/t` `/c` `/n`. Typing `/` shows live matching hints in the status bar.

Environment variables: `THINCODER_API_KEY` (or `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`), `THINCODER_BASE_URL`, `THINCODER_MODEL`, `SILICONFLOW_API_KEY`.

## Configuration

`~/.thincoder/config.json`:

```jsonc
{
  "providers": [
    // multiple allowed; switch with /model <name>
    {
      "name": "deepseek",
      "baseURL": "https://api.deepseek.com/v1", // any OpenAI-compatible endpoint
      "apiKey": "sk-...", // or leave empty to use env vars
      "model": "deepseek-chat",
      // optional: proactive throttling budget (match your account's rate-limit tier;
      // without it the gate is off, 429 backoff still applies).
      // Rate limits are per-account counters (RPM/TPM over a 60s window) — check each vendor's console
      // "tpm": 200000, // tokens/minute (input + output total)
      // "rpm": 50,     // requests/minute
    },
  ],
  "activeProvider": "deepseek", // currently active provider name
  "embedding": {
    // optional: without it, retrieval is pure FTS
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-...", // or SILICONFLOW_API_KEY
    "model": "BAAI/bge-m3",
  },
  "agent": {
    "maxTurns": 100, // tool-loop cap
    "compactThreshold": 100000, // context compaction threshold (approx. tokens)
  },
  "memory": {
    "dbPath": "~/.thincoder/memory.db", // sqlite index path
    "projectDir": ".thincoder/memory", // Project layer directory (relative to project root)
    "team": {
      // optional: Team layer disabled without it
      "name": "myteam",
      "repo": "git@github.com:org/team-memory.git",
    },
  },
  "mcp": {
    // optional: MCP server list
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      },
    ],
  },
}
```

## Architecture

```
bin/thincoder.mjs   command entry (tui / chat / memory / sync / distill)
src/
  provider/         LLM calls — core.mjs (fetch, SSE streaming, reasoning_content, usage, retries),
                    rate.mjs (TPM/RPM proactive rate gate), index.mjs (entry)
  embedding.mjs     vector embeddings (OpenAI-compatible /v1/embeddings)
  tools/            16 builtin tools + MCP wrapping + readonly scheduling flags
                    index.mjs (registry), file/git/patch/system/web.mjs (groups), shared.mjs (schema utils),
                    repomap.mjs (repo dependency outline: import/export regex parsing, on-demand via tool)
  tools.mjs         re-export shim → src/tools/index.mjs
  mcp/              MCP client — helpers.mjs, transport-stdio/http/ws.mjs (JSON-RPC, zero-dependency)
  mcp.mjs           MCP client entry (connectMcpServer), delegates to src/mcp/
  agent.mjs         main loop + two-phase tool execution + reminder injection + completion guard + fix-verify loop
                    + incremental indexing (auto reindexFile after write/edit/delete)
  agent/            agent loop helpers — dispatch.mjs (two-phase execution), setup.mjs (system prompt assembly), helpers.mjs
  agent-tools/      self-discipline tools (task/plan/goal/verify/subagent/skill/recent_changes)
  context.mjs       rough token estimation + history compaction + task re-injection
  memory/           three-layer memory — schema.mjs (DDL/constants), core.mjs (CRUD + retrieval),
                    code-index.mjs + code-sync.mjs (code_chunks), docs.mjs (doc_chunks)
  memory.mjs        re-export shim → src/memory/*
  session.mjs       session persistence (up to 5 archive slots, isolated by project cwd)
  skills.mjs        skill discovery/loading (.thincoder/skills/*.md)
  markdown.mjs      entry format (frontmatter parse/serialize)
  git/              checkpoint.mjs (git patch snapshots / rewind), gitmem.mjs (Team layer git sync)
  distill.mjs       session knowledge extraction (candidates + human confirmation)
  config.mjs        config loading
  tui/              bare-ANSI terminal UI — index.mjs (startTUI), render.mjs (drawing primitives),
                    render-frame.mjs (frame layout), ansi.mjs
  tui.mjs           re-export shim → src/tui/index.mjs
  tui-render.mjs    re-export shim → src/tui/render.mjs
  prompts/          prompt texts — system.md (core), discipline.md (coding/testing rules),
                    main.md (main-agent overlay), explore.md / coder.md / plan.md (subagent roles)
test/               node:test offline unit tests (npm test)
scripts/            real-environment verification scripts (compaction, team sync)
```

Key design decisions:

- **Two-phase tool execution**: phase one serializes permission prompts (each side-effect tool asks the user); phase two runs read-only tools in parallel (`Promise.all`) and side-effect tools serially. Results are fed back paired by `toolCallId`
- **Permissions live in the UI layer**: tools only execute; "ask the user or not" is the TUI/CLI's business, so headless scenarios need no tool changes
- **The index is disposable**: sqlite is just a local index of code/docs/memories — `reindex` rebuilds it anytime
- **Separate code/doc indexes**: source and markdown docs are indexed in separate tables and searched through different tools — keeps the model from mistaking old code patterns for design conventions
- **git boundaries**: the Project layer only writes files and never touches your repo's commits; the Team layer is a ThinCoder-managed repo where auto commit+push is allowed
- **CJK retrieval**: FTS5 unicode61 + per-character CJK spacing on both write and query sides; semantic matching goes through the vector channel

## Development

```bash
npm test                          # offline unit tests (node:test, with local mock servers)
node scripts/verify-compress.mjs  # real-API verification of context compaction (needs valid config)
node scripts/verify-team.mjs      # team memory A->git->B full-chain verification (local git, offline)
```

Code conventions: pure `.mjs`, no semicolons, no npm dependencies allowed (including devDependencies).

## Roadmap

- More builtin skills

## Changelog

### 0.8.13 (2026-07)
- **TUI: incremental rendering** — panel-level cache (`panelCache`) with sync-update bracketing (`DECSET 2026`). Only redraws changed panels, eliminating flicker. `saveCursor`/`restoreCursor` for efficient cursor positioning. Panel order reorganized: `header → conversation → subagent → output → todo → picker → permission → queue → input → status`.
- **Ctrl+I inject resume** — Ctrl+I (or Tab during processing) now properly interrupts, injects the message, and *resumes* the agent loop. Controller is recreated after abort. Added active signal check in SSE read loop for faster abort on Windows.
- **Processing hints** — Input box shows "Ctrl+U clear" hint during processing. Tab during processing treated as Ctrl+I. Slash commands re-render the frame.
- **Compression visibility** — `compressIfNeeded` now forwards `onToken`/`onReasoning` callbacks, making compression activity visible in the TUI.
- **Session: data-preserving fallback** — when atomic rename fails during session save, fall back to direct write instead of losing data.
- **Distill: balanced-bracket JSON extraction** — handles nested arrays in LLM output (e.g. `"tags": ["a", "b"]`), replacing the broken non-greedy regex approach.
- **File tools: EOL normalization** — `normalizeEOL` (`\r\n` → `\n`) applied on all reads (`read`, `edit`, `hashline_edit`, `insert_after`, `grep`, `repomap`), making hash computation and string matching platform-consistent.
- **hashline_edit: multiple-match detection** — when a hash sequence matches multiple positions, reports all with surrounding context instead of silently picking one.
- **delete: symlink-safe** — uses `lstat` instead of `stat` to correctly identify symlinks (not directories even if pointing to one).
- **repomap: large file guard** — skip files >10MB in dependency outline builds to prevent OOM.
- **Improved error messages** — `grep` and `insert_after` now catch invalid regex patterns at validation time with clear error messages.
- **Advisor session persistence** — advisor config saved/restored across sessions.
- **Timeout hardening** — auto-think uses `AbortSignal.timeout(5s)`, embedding requests add 60s timeout, MCP HTTP connect uses `INIT_TIMEOUT_MS`, fetch timeout extended to 10 minutes.
- **ClearScreen on exit** — terminal restored with `clearScreen` ANSI on TUI cleanup.

### 0.8.12 (2026-07)
- **Indexing: git-repo-only** — `codeSync` and `docSync` now only index inside git worktrees (via `git ls-files`), respecting `.gitignore`. Non-git directories get empty indexes. Prevents 2.9GB memory.db from accidentally indexing entire user profiles (AppData, browser extensions, Office add-ins, Program Files)
- **Indexing: file-size caps** — code files >1MB and doc files >512KB are skipped during bulk indexing (minified bundles, test fixtures, generated code)
- **Compaction: earlier trigger** — `COMPACT_RATIO` lowered from 0.8 to 0.6 (with 40K floor), so injected context (directory tree, git context, outline, memory/doc search results) doesn't starve the model for headroom before compaction fires
- **Bugfix: event-loop blocking** — `buildOutline`/`buildSummary` in `repomap.mjs` now awaited (was sync calling async), `setup.mjs` outline injection fixed, `codeSync` walk uses `readFile` instead of `readFileSync`
- **Feat: SKIP_DIRS expanded** — Windows profile directories (`AppData`, `Desktop`, `Documents`, `Downloads`, `Music`, `Pictures`, `Videos`, etc.) added to the skip list
- **Feat: `listProjectFiles` shared helper** — extracted from `codeSync`/`docSync`, used by both; git-only with fallback removed
- **Refactor: `embed-config.mjs`** — simplified to only read API key via `resolveEmbedKey()`, base URL and model are fixed constants; VSCode SecretStorage dependency removed

### 0.8.11 (2026-07)
- **Feat**: `checklist` tool — persistent project task tracking in `.thincoder/checklist.md`. Add/mark/list items, auto-archive done items to `checklist-done.md`. Injected at session start (pending + in_progress only)
- **Feat**: updated prompts — four-step workflow (requirements→design→development→testing), three-step debugging strategy (logs→docs→binary search), working checklist discipline
- **Feat**: methodology docs — `docs/design/METHODOLOGY.md` rebuilt, `PHILOSOPHY.md` expanded with worldview #6 (official docs over guessing)
- **Bugfix**: vision guard — `read_image` now refuses non-vision models before reading the file, the agent loop injects a system reminder instead of image parts for text-only models, and `stripImagesForTextModel` sanitizes image parts at send time (history untouched, restored when switching back to a vision model). Previously a single image in history made text-only APIs (e.g. DeepSeek) reject EVERY subsequent request with 400, bricking the conversation
- **Improvement**: silent `catch {}` blocks now log to stderr (checkpoint file copies, MCP notify/close, session incremental save, clipboard paste, provider picker, team-memory rebase abort, tool dispatch) — failures are visible for debugging instead of disappearing

### 0.8.10 (2026-07)
- **Bugfix**: pasted text now lands in the active TUI text target — the API key prompt when adding a provider via `/model` (and any free-text `askQuestion`) now accepts paste correctly. Previously, bracketed-paste injection in the terminal was always written to the main input box, so pasting into a question prompt appeared as "nothing happened" and orphaned the text into the input box after the question closed. Both bracketed-paste (Windows Terminal / most modern terminals) and Ctrl+V-as-key-event (legacy conhost) now route through a single `insertPastedText` helper that targets the question answer, options-list (ignored), or main input box as appropriate

### 0.8.9 (2026-07)
- **Bugfix**: `wizardProviderItems` was defined inside `createWizard()` but not included in the return statement, causing key-handler to crash with `TypeError` during provider selection on first launch (/ new config)

### 0.8.8 (2026-07)
- **Bugfix**: remove env whitelist from bash tool — child processes receive full parent environment
- **Bugfix**: reduce TUI flicker — single `write` with `home` + `clearToEnd` instead of separate cursor moves
- **Feat**: auto update check on startup + `/upgrade` command

### 0.8.3 (2026-07)
- **Output panels**: tools with `outputPanel` flag stream to scrolled panel, auto-collapse to summary on completion (bash, long tool results)
- **Checkpoint enhancements**: `cat` for file preview from snapshots, per-file rewind, auto-recover on apply failure, escape-hatch hints on errors
- **Bash safety**: `checkpoint-before-destructive` discipline rule; bash guard guides checkpoint instead of just commit/stash
- **Code review fixes**: output friendliness, readability, English-only strings, TUI polish

### 0.8.0 (2026-07)
- **TUI rendering overhaul**: layout engine (`layout.mjs`) — panels are positioned declaratively by priority instead of hand-pinned arithmetic; `renderFrame` is now a pure function (no state mutation); cursor position derived from layout coordinates. Status bar slash-command hints moved from if-else chain to lookup table. Three Chinese UI strings fixed to English
- **Subagent panel redesigned**: per-instance tracking (`role#id/` prefix) — parallel subagents of the same role no longer overwrite each other. Shows current tool name + args, or streaming text last line (what it's writing right now), instead of truncated 200-char token fragments. `onToolCall` relayed from subagent to parent TUI. Only the earliest running subagent is marked done on completion (not all)
- **Tool file split**: `system.mjs` (337 lines) split into `bash.mjs` / `glob.mjs` / `grep.mjs` / `ls.mjs`; `repomap.mjs` (306 lines) split into `repomap.mjs` (public API) + `repomap-parse.mjs` (dependency graph parsing)
- **Export position normalization**: 8 files rearranged — exports at top, implementation helpers below, for top-down readability
- **Provider management UX**: Add Provider excludes already-added presets from the list; Esc in sub-pickers (Add/Remove/Key) returns to model picker instead of exiting; config operations no longer leave traces in the conversation flow (picker refresh is the feedback); `❯ You:` label restored for user messages
- **distill-cmd import fix**: resolved export name mismatch that crashed TUI startup

### 0.7.8 (2026-07)
- **Provider config flow streamlined**: adding a provider now immediately prompts for API key (no more "go back to /provider → Set Key"). Switching to a keyless provider via `/model` also prompts for key inline. Empty input gives clear "skipped" feedback
- **bash tool: file writing forbidden**: models must use write/edit/insert_after/apply_patch instead of `echo`/`sed`/`printf > file`. Fixes GBK encoding corruption on Chinese Windows (cmd.exe writes redirected files in ANSI code page, not UTF-8). `PYTHONIOENCODING=utf-8` set for Python subprocesses on Windows

### 0.7.7 (2026-07)
- **Code review fixes (4 critical bugs)**:
  - `gitSync` anchor never set after full `codeSync` fallback → fast path was dead in production; now `codeSync`/`docSync` write the anchor on success
  - `gitSync` skipped deleted files → stale chunks remained in index forever; `--diff-filter` now includes `D`, and `ENOENT` is distinguished from other errors (failed files don't advance the anchor)
  - Completion guard was a one-shot latch → after firing once, further mutations could finish unverified; now re-armed with a pushback counter (max 2 pushes, 3rd passes through)
  - Verify-failure exhaustion returned raw model text without honesty framing → now injects a system reminder forcing the model to state what's still failing, what was tried, and that the work is unfinished
- **Input queue during processing**: messages typed while the agent is processing are queued and auto-executed when processing ends. Queue preview shown as a single line above the input box (no collision with subagent panel). `Ctrl+D` deletes the last queued item. `/cancel` and `/exit` bypass the queue

### 0.7.6 (2026-07)
- **SYSTEM_PROMPT split into core + discipline**: core rules (shared by all agents) separated from coding/testing/debugging discipline (main agent + coder), so explore/plan subagents no longer burn attention on irrelevant coding clauses — single source of truth, one rule changed in one file
- **git-driven incremental indexing**: new `gitSync` uses `git diff` at startup to find files changed since the last index and rebuilds only their FTS5 chunks. Non-git repos / first run / large changesets (>200 files) automatically fall back to full scans. `codeSync` + `docSync` startup parallelized
- **Embeddings backfilled right after reindexFile**: incremental indexing after each agent write/edit no longer leaves vector NULLs — `ensureEmbeddings` runs immediately, so freshly changed files are semantically searchable at once
- **Project-instruction injection hardening**: AGENTS.md content wrapped with `escapeXml` + `<untrusted_project_instructions>`, closing the prompt-injection hole from malicious project instructions
- **Compaction threshold cap**: for 1M-window models the compaction threshold drops from 800K to 300K tokens (`COMPACT_CAP_TOKENS`), preventing history from blowing the TPM budget and the compaction request itself from hitting 429
- **readSSE tool_calls name dedup**: some APIs (GLM occasionally) resend the full name instead of deltas in the stream, and `+=` produced `readread`. Now only the first non-empty value is taken
- **Edge-case thinking across all prompt layers**: plan/explore/coder/main overlays each gained an edge-case recognition rule (open-ended, no scenario enumeration)
- **Testing discipline refined**: full-test trigger changed from "touched core infrastructure files" to "changed core infrastructure behavior" — adding a helper to memory.mjs no longer triggers the full suite

### 0.7.5 (2026-07)
- **Compound prompt instructions split**: 8 compound sentences across SYSTEM_PROMPT / main-overlay / coder-overlay split into independent bullets (one attention node per instruction), improving instruction-following on DeepSeek/GLM/Qwen — fallback clauses like "add tests after changing code" no longer get skipped
- **Testing discipline strengthened**: SYSTEM_PROMPT Testing discipline gained an independent hard rule (changing behavior/adding code requires tests); main-overlay self-review checklist gained "do existing tests cover the change"; coder-overlay final checklist gained a test item
- **Plan mode workflow**: main-overlay's plan mode instruction split from one compound sentence into a 3-step numbered flow

### 0.7.4 (2026-07)
- **verify tiered self-check**: default quick mode (syntax-check changed files + git diff + self-review checklist, milliseconds); `full=true` also runs the full npm test suite — no more waiting ten-plus seconds per line changed; quick satisfies the completion guard, use full when wrapping up or touching core infrastructure
- **Prompt discipline strengthened**: SYSTEM_PROMPT gained Testing discipline (when to run which tier) and Debugging strategy (diagnose before treating, one change at a time); coder/plan/main overlays gained self-review checklists (simplest solution, match project patterns, don't touch unrelated files)
- **Fix**: quick mode marked verification passed even when syntax checks failed, gutting the completion guard

### 0.7.3 (2026-07)
- **Image paste**: new `read_image` tool — paste images/videos from the clipboard, multimodal models directly understand screenshots, UI mockups, architecture diagrams (Win: `Alt+V` / Mac/Linux: `Ctrl+V`)
- **TUI paste hint**: with a multimodal model, the input box corner shows the OS-appropriate paste shortcut; hidden for text-only models

### 0.7.2 (2026-07)
- **TPM/RPM proactive rate gate**: with `tpm`/`rpm` budgets configured on a provider, requests are booked against a local sliding window (60s, input+output) before sending — over budget means sleeping until the window frees up instead of gambling on 429s; covers the main loop / compaction summaries / subagents / truncation resume. Status bar shows `TPM throttle wait ~Ns`; the gate is off for unconfigured providers
- **429-specific backoff**: respects the `Retry-After` header, otherwise backs off 15s/30s/60s (60s window — sub-second backoff is pointless); quota/balance errors (`exceeded_current_quota_error`) are distinguished from rate limits and no longer retried uselessly
- **Dependency injection as compact summary**: `buildSummary` (directory-level dependencies + hub files + entry points, naturally ~1-2k chars) replaces the full-outline injection; detailed import/export available on demand via `repo_outline`
- **TUI menus**: `/model` `/config` `/provider` `/think` `/mcp` `/goal` `/session` `/restore` unified into picker menus
- **Session robustness**: corrupted files or disk errors during archive/switch no longer crash — silently abandoned

### 0.7.1 (2026-07)
- **Context explosion fix (urgent)**: the startup dependency-outline injection is no longer unbounded — a multi-repo parent directory (thousands of indexed files) produced a 1.4M-char ≈ 350K-token outline, re-injected every turn, blowing up context within a few turns and tripping TPM limits. Now truncated to 6000 chars (with a pointer to `repo_outline` for focused queries) and injected only once per session
- **Compaction escape hatch**: when history was too short (≤13 messages) to slice a middle section, compaction never happened — one giant message (huge paste/oversized injection) could deadlock. Now a deterministic slimming path: oversized user/tool bodies are truncated to stubs, reasoning_content and tool_calls pairing untouched
- **docSync ReferenceError fix**: undeclared `failed`/`errors` made every doc index sync throw (two tests red)
- **apply_patch tool**: unified-diff multi-file atomic patching (any failed hunk → nothing written), permission preview shows the diff directly
- **checkpoint tool**: `list`/`create`/`rewind` snapshot abilities exposed to the model (previously only wired to TUI auto-snapshots + /rewind, so the model couldn't save itself); the bash destructive-git guard upgraded to per-segment detection (chained forms like `&&`/`;`/`|`/command substitution no longer slip through)
- **bash process-tree kill**: timeout/interrupt kills the whole tree (POSIX process groups / Windows taskkill /T) — no orphaned grandchildren
- **Subagent display contract**: only content/thinking tokens relay to the TUI scrolling area; internal tool calls no longer flood the screen
- **Path safety**: `resolveInCwd` prevents symlink escapes (realpath double-check); edit rejects empty old_string; single-file incremental indexing skips hidden directories and node_modules
- **Misc**: SQLite WAL + busy_timeout, single-transaction schema migrations, semantic version comparison for upgrades, MCP cmd.exe quote-doubling escape, gitmem skips commits when nothing changed

### 0.7.0 (2026-07)
- **Deep model protocol adaptation**: reasoning_content echo differentiated per model (`reasoningEcho` spec field) — DeepSeek/Kimi must echo, GLM must not; reasoning_effort enum validation (`reasoningEffortEnum`); temperature range clamping (`tempRange`)
- **Qwen/MiniMax spec completion**: reasoning_effort enums (Qwen 3.8-max-preview), temperature ranges (Qwen [0,2), MiniMax [0,2]), MiniMax M3 thinking mode
- **grep context lines**: `before`/`after` params (grep -B/-A equivalents), matches marked with `:`, context with `-`, adjacent ranges in the same file merged and deduped
- **System prompt boundary rule**: never modify files outside the working directory; never use bash to bypass the read/write/edit directory confinement
- **question tool input box title**: fixed to ` Question `, question text goes to the conversation area (no longer crammed into the box title)

### 0.5.0 (2026-07)
- **Codebase understanding**: `repo_outline` (dependency outline, auto-injected at startup), `code_search` (FTS5 + vectors + JSDoc), `doc_search` (chunked by ## headings), auto-incremental indexing on file writes
- **Model adaptation**: 5 built-in presets (DeepSeek/Kimi/GLM/Qwen/MiniMax), maxTokens maxed out, truncation resume, thinking-mode APIs auto-matched
- Session 5-slot archiving, `/session` switching, tool results shown after restore
- Subagent streaming output visible, final reports in the conversation area
- File tools confined to the working directory, permission preview above the input box
- write/edit auto-attach git diffs, edit error messages with better hints
- task auto-filters completed items, proactive reminder when all done
- Prompt guidance: "check official docs → save discrepancies to project memory"

### 0.4.0
- Permission approval shows content previews (write content, edit diff, bash command)
- Todo panel progress visualization, status bar token usage and context utilization
- Two-layer project instructions merge (global + project AGENTS.md)

### 0.3.0
- MCP client (JSON-RPC + stdio, zero-dependency)
- Skills system (`.thincoder/skills/*.md`)
- Plan/Goal/Question tools
- Prompts externalized to `.md` files, subagent role overlays
- Strict task discipline (keep ONE in_progress), completion guard (file changes blocked without verify)
- DeepSeek thinking echo, system prompt prefix caching
- checkpoint snapshots + `/rewind` rollback

### 0.2.0
- multi-provider configuration (switch between endpoints)
- Initial setup wizard (arrow-key model picker, key entry)
- `/think` thinking mode toggle and reasoning effort
- `/model` model picker
- bash streaming output passthrough

### 0.1.0
- Agent main loop, 14 builtin tools, zero-dependency TUI
- Three-layer memory (personal/project/team), FTS5 retrieval
- Session persistence, context compaction, streaming SSE

## License

MIT
