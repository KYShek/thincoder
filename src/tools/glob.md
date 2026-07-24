Find files by glob pattern (e.g. 'src/**/*.mjs'). Returns matching paths.

Parameters:
- pattern (required): Glob pattern — supports **, *, ?, and character classes
- path: Directory to search in (default cwd)

Notes:
- Skips node_modules, .git, dist, build, .turbo, coverage
- Results capped at 1000 matches
- Use this to discover file structure; use grep to search file contents
- Prefer patterns with a literal anchor (extension or subdirectory) over bare wildcards
