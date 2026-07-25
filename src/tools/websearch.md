Search the web (Bing). Returns result titles, URLs, and snippets. Use for looking up current information, docs, error messages.

Parameters:
- query (required): Search query
- limit: Max results (default 8)

Notes:
- Before searching the web, call `memory_search` first — you may already know the answer from a previous session. Only reach for websearch if memory comes up empty.
- Use this for information that is NOT in the local codebase — current docs, error messages, API references
- Follow up with `fetch` to read full pages from the results
- Results are scraped from Bing HTML — some formatting may be imperfect
