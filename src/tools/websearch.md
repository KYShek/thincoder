Search the web (Bing). Returns result titles, URLs, and snippets. Use for looking up current information, docs, error messages.

Parameters:
- query (required): Search query
- limit: Max results (default 8)

Notes:
- Use this for information that is NOT in the local codebase — current docs, error messages, API references
- Follow up with `fetch` to read full pages from the results
- Results are scraped from Bing HTML — some formatting may be imperfect
