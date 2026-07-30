Search the web. By default fires all engines concurrently and merges results (round-robin for diversity). Specify an engine to target a single source, with optional page for pagination.

Parameters:
- query (required): Search query
- limit: Max results (default 8, max 20)
- engine: Specific engine to use — "bing" (Bing 国际), "bing_cn" (Bing 国内). Omit to search all engines concurrently.
- page: Page number for pagination (1-based, default 1). Only used when engine is specified.

Notes:
- Before searching the web, call `memory_search` first — you may already know the answer from a previous session. Only reach for websearch if memory comes up empty.
- Use this for information that is NOT in the local codebase — current docs, error messages, API references
- Follow up with `fetch` to read full pages from the results
- Merged results are prefixed with `[bing]` / `[bing_cn]` to show the source
