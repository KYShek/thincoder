# AGENTS.md — ThinCoder Project Guide

## Project Overview

Zero-dependency AI coding CLI: pure Node.js >= 24 standard library, no build step, ESM (`.mjs`).
LLMs are accessed via the OpenAI-compatible protocol (`provider.mjs` native fetch + SSE streaming), tracking only flagship models from leading Chinese vendors (DeepSeek / Kimi / GLM / Qwen / MiniMax).
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
src/agent.mjs       main loop + self-discipline tools (task/plan/goal/verify/subagent/skill/recent_changes)
                    + reminder injection (task/goal/plan/mode switches) + completion guard + fix-verify loop
                    + incremental indexing (auto reindexFile after write/edit/delete) + dependency summary injection
src/provider.mjs    LLM calls (SSE, reasoning_content, usage, retries + TPM/RPM proactive rate gate)
src/tui.mjs         bare-ANSI TUI (conversation / todo panel / input box / status bar / pickers / subagent panel)
                    all slash commands converted to cursor-list pickers
src/tools.mjs       20+ file/network/git tools; descriptions in src/tools/*.md
                    automatic node --check incremental syntax check after file modifications
src/context.mjs     context compaction (key decisions saved before compaction, task/plan state re-injected after)
src/memory.mjs      three-layer memory (personal/project/team) + code/doc indexing (code_chunks + doc_chunks, FTS5 + vector RRF)
                    + JSDoc/docstring extraction + single-file incremental indexing
src/repomap.mjs     repo dependency outline (import/export parsing, compact summary + full detail on demand)
src/session.mjs     session persistence (up to 5 archive slots)
src/embedding.mjs   vector embeddings (SiliconFlow bge-m3 / generic OpenAI /v1/embeddings)
src/mcp.mjs         MCP client (stdio + HTTP + WebSocket)
src/config.mjs      config loading + provider preset management
src/checkpoint.mjs  git checkpoints (snapshot → rewind)
src/skills.mjs      project skill loading
src/markdown.mjs    frontmatter parsing (zero-dependency)
src/distill.mjs     session knowledge extraction
src/gitmem.mjs      Team layer git sync
src/SYSTEM_PROMPT.md   core prompt (shared by main/sub agents)
src/main-overlay.md    main-agent-only clauses (subagent/goal/verify/skill/plan mode)
src/{explore,coder,plan}-overlay.md   subagent role texts
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
