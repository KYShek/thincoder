Check a JavaScript file for syntax errors using `node --check`. Fast, offline, no dependencies — use after writing or editing .js/.mjs/.cjs files to catch parse errors before running tests.

Parameters:
- path (required): File path (.js, .mjs, or .cjs)

Notes:
- Only supports JavaScript-family files; for other languages, run the appropriate checker via `bash`.
- Returns "Syntax OK" or the exact error message with line/column from Node.js.
- This is NOT a test run — it only catches parse errors (missing brackets, invalid syntax), not logic bugs.
- Use this right after `write` or `edit` to fail fast on trivial mistakes before investing time in a full test run.
