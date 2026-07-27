# AGENTS.md — ThinCoder Project Guide

## Project Overview

Zero-dependency AI coding CLI: pure Node.js >= 24 standard library, no build step, ESM (`.mjs`).
LLMs are accessed via the OpenAI-compatible protocol (`src/provider/` native fetch + SSE streaming), tracking only flagship models from leading Chinese vendors (DeepSeek / Kimi / GLM / Qwen / MiniMax).
Design docs live in `../thincoder-design/` (REQUIREMENTS.md / ARCHITECTURE.md / ARCHITECTURE-v2.md).

## Hard Constraints

- **Zero npm runtime dependencies**: only `node:` standard library (storage via `node:sqlite`, terminal via bare ANSI). For new features, first ask whether the standard library can do it; if not, raise it for discussion
- No TypeScript, no build/bundling step of any kind
- Every change must actually be verified by running it — no "written but never run" code

## Design Principles (full text: ../thincoder-design/ARCHITECTURE.md#设计原则)

1. **Zero dependencies** — every npm package is a unit of technical debt
4. **Accuracy over brevity** — context should err on the long side; 1M windows are the norm
5. **Code is the problem, not the answer** — don't treat existing code as authoritative
6. **Global-facing, no Chinese-only assumptions** — code and TUI are in English

## Verification

Tiered self-check strategy — don't run the full suite for every line changed:

```bash
node --check file.mjs   # syntax check: run immediately after every write/edit, milliseconds
```

```bash
# verify tool (default quick mode): syntax-checks all changed files + git diff + self-review checklist
# satisfies the completion guard, enough to finish a task
# verify full=true: quick + npm test
```

```bash
npm test    # full suite (117 tests, ~11s): run only when
            #  a) marking the last task done and declaring completion
            #  b) core infrastructure BEHAVIOR changed (agent loop / provider protocol / config schema / tool execution / memory schema) — touching a file doesn't count, changing behavior does
            #  c) the user explicitly asks
```

TUI interaction paths (permission prompts, todo panel, compaction notice, status bar) have no offline coverage — do a manual smoke pass before release (see "Release" below).

## Structure

```
bin/thincoder.mjs   command entry & dispatch (chat/memory/sync/distill/reindex/upgrade/-v)
src/agent.mjs       main loop + reminder injection (task/goal/plan/mode) + completion guard + fix-verify loop
                    + incremental indexing (auto reindexFile after write/edit/delete) + dependency summary injection
                    (self-discipline tools split into agent-tools/, loop helpers into agent/)
src/agent/          agent loop helpers: dispatch (two-phase tool execution), setup (system prompt assembly), helpers
src/agent-tools/    self-discipline tools (task/plan/goal/verify/subagent/skill/recent_changes), loaded via agent-tools.mjs
src/provider/       LLM calls — core.mjs (SSE, reasoning_content, usage), rate.mjs (TPM/RPM gate), index.mjs (entry)
src/tui/            bare-ANSI TUI — index.mjs (startTUI + render side-effects), layout.mjs (declarative panel layout engine),
                    render.mjs (drawing primitives: charWidth/wrapText/formatTables/sanitize), render-frame.mjs (pure frame renderer),
                    ansi.mjs, agent-turn.mjs, key-handler.mjs, startup.mjs, interaction.mjs, pickers.mjs, wizard.mjs,
                    slash-commands.mjs + cmd-*.mjs (per-command handlers), config-helpers.mjs, clipboard.mjs
                    (conversation / todo panel / subagent panel / input box / status bar / pickers / wizard; slash commands → cursor-list pickers)
src/tui.mjs         re-export shim → src/tui/index.mjs
src/tui-render.mjs  re-export shim → src/tui/render.mjs
src/tools/          20+ file/network/git tools; descriptions in src/tools/*.md
                    index.mjs (builtinTools registry), file/git/patch/bash/glob/grep/ls/web.mjs (tool groups), shared.mjs (schema utils)
                    repomap.mjs (repo dependency outline: public API), repomap-parse.mjs (import/export parsing + dependency graph)
                    automatic node --check incremental syntax check after file modifications
src/tools.mjs       re-export shim → src/tools/index.mjs
src/context.mjs     context compaction (key decisions saved before compaction, task/plan state re-injected after)
src/memory/         three-layer memory — schema.mjs (constants/DDL), core.mjs (CRUD + retrieval), code-index.mjs + code-sync.mjs (code_chunks),
                    docs.mjs (doc_chunks), FTS5 + vector RRF + JSDoc extraction + single-file incremental indexing
src/memory.mjs      re-export shim → src/memory/*
src/session.mjs     session persistence (up to 5 archive slots)
src/embedding.mjs   vector embeddings (SiliconFlow bge-m3 / generic OpenAI /v1/embeddings)
src/mcp/            MCP client — helpers.mjs, transport-stdio/http/ws.mjs
src/mcp.mjs         MCP client entry (connectMcpServer), delegates to src/mcp/
src/config.mjs      config loading + provider preset management
src/git/            checkpoint.mjs (git checkpoints: snapshot → rewind), gitmem.mjs (Team layer git sync)
src/skills.mjs      project skill loading
src/markdown.mjs    frontmatter parsing (zero-dependency)
src/distill.mjs     session knowledge extraction
src/prompts/        prompt texts — system.md (core, shared by main/sub), discipline.md (coding/testing rules),
                    main.md (main-agent-only: subagent/goal/verify/skill/plan), explore.md / coder.md / plan.md (subagent role texts)
test/units.test.mjs   all offline tests (including runAgent end-to-end driven by a mock LLM server)
```

## Key Design Constraints (read before changing anything)

- **Prefix caching**: the system prompt must be byte-stable across runs — it may only contain content stable per cwd/session; per-turn varying content (e.g. memory injection) must go through separate user context messages. Adding dynamic content to the system prompt breaks DeepSeek context caching
- **Thinking echo**: whether assistant messages with tool_calls echo `reasoning_content` back is decided by the spec-table field `reasoningEcho` — `"required"` (DeepSeek/Kimi K3) must echo; `"optional"` (GLM) must not; undeclared conservatively does not
- **Reminder injection** uniform format: `role: "user"` with `[System reminder: ...]`; task-idle reminders are injected only for the top-level agent (depth=0); user/external text must be XML-escaped and wrapped in `<untrusted_*>` tags before injection
- **Tool results** over 16k chars are automatically offloaded to `~/.thincoder/tool-results/`; the model only sees a preview + path
- **Codebase understanding**: three retrieval tools — `repo_outline` (dependency graph), `code_search` (source FTS5 + vectors), `doc_search` (docs chunked by headings). The prompt guides the model to use them in "structure → intent → details" order
- **Auto incremental indexing after file modifications**: `reindexFile` runs after write/edit/delete
- **Fix-verify loop**: file changes without verify get pushed back to verification; verify runs `node --check` + `npm test`; at most 3 repair rounds on failure

## Commits & Release

- Commit messages: `type: summary` (feat / fix / release / docs), single English line; release commits carry a change list in the body
- Release flow: bump `package.json` version → `npm publish` (`prepublishOnly` runs the full suite automatically) → commit + `git tag vX.Y.Z` → `git push origin main --tags`
- Manual smoke before release (~5 minutes):
  1. Give a file-writing task in the TUI → permission prompt shows a content preview (yellow), approval leaves a trace
  2. Give a multi-step task → todo panel appears, done items struck through, auto-collapses when all done; counter in the status bar
  3. Trigger compaction with a long conversation → `[context]` notice appears, task state preserved
  4. Status bar token usage (`↑x ↓y hit z%`) and context utilization grow with requests
  5. `thincoder -v` prints the same version as package.json; `thincoder chat "..."` one-shot Q&A works
