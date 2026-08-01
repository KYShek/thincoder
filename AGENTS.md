# AGENTS.md — ThinCoder Project Guide

## Project Overview

Zero-dependency AI coding CLI: pure Node.js >= 24 standard library, no build step, ESM (`.mjs`).
LLMs via OpenAI-compatible protocol, flagship models from DeepSeek / Kimi / GLM / Qwen / MiniMax.
Design docs in `docs/design/`. Complete pipeline: [`PHILOSOPHY.md`](docs/design/PHILOSOPHY.md) → [`METHODOLOGY.md`](docs/design/METHODOLOGY.md) → prompts.

## Hard Constraints

- **Zero npm runtime dependencies**: only `node:` standard library (storage via `node:sqlite`, TUI via bare ANSI). For new features, first ask whether the standard library can do it; if not, raise for discussion.
- No TypeScript, no build/bundling step.
- Every change must be verified by running it — no "written but never run" code.

## Key Conventions

- **Reminder format**: all system reminders use `role: "user"`, `[System reminder: ...]` prefix and must not be mentioned in replies. External/user text injected into reminders must be XML-escaped in `<untrusted_*>` tags.
- **Prefix caching**: the system prompt must be byte-stable across runs — per-turn varying content goes in user messages, not the system prompt.
- **Thinking echo**: `reasoning_content` in assistant tool_calls messages depends on the model's `reasoningEcho` spec field.
- **Commit messages**: `type: summary` (feat / fix / release / docs), single English line.
- **Release flow**: bump `package.json` version → `npm publish` → commit + `git tag vX.Y.Z` → `git push origin main --tags`. Manual smoke pass before release. **Version bumps default to patch (third digit) only** — never bump minor/major unless the user explicitly says so.
- **Discussion → docs**: design decisions, architecture choices, and naming conventions discussed in chat don't exist until they're in a doc file. After any design discussion, write the conclusions to the relevant document immediately — not "later". Chat context compresses; docs persist.
- **File size**: single `.mjs` / `.js` source file exceeding 300 lines → advisory (🟡): suggest splitting. Exceeding 500 lines → blocking (🔴): must split before merge. Test files (`test/**`) and generated code are exempt.

## Key Modules

```
bin/thincoder.cjs    CLI entry
src/agent.mjs        main loop + reminder injection + verifyGuard (opt-in) + incremental indexing
src/agent/           loop helpers (dispatch, setup, helpers, post-turn, completion)
src/agent-tools/     self-discipline tools (task/plan/goal/verify/subagent/skill)
src/prompts/         system prompts (system.md / discipline.md / main.md + subagent roles)
src/provider/        LLM calls (native fetch + SSE)
src/tools/           built-in tools (file/git/bash/search/web/checklist)
src/tui/             bare-ANSI terminal UI
src/memory/          three-layer FTS5 + vector memory
src/context.mjs      context compaction
src/config.mjs       config + provider presets
src/mcp/             MCP client (stdio/http/ws transports)
test/                test suite
```
