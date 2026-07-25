Search file contents with a regex. Returns matching lines as path:line: content.

Parameters:
- pattern (required): JavaScript regular expression
- path: Directory or file to search (default cwd)
- glob: Only search files matching this glob (e.g. '*.mjs')
- before: Lines of context to show before each match (grep -B). Default 0
- after: Lines of context to show after each match (grep -A). Default 0

Notes:
- Skips node_modules, .git, dist, build, .turbo, coverage
- Results capped at 200 matches
- Binary/unreadable files are silently skipped
- Use this to find usages, definitions, patterns; use glob to find files by name
- With before/after: matching lines use `:` separator, context lines use `-` (like ripgrep); overlapping context ranges in the same file are merged and de-duplicated
