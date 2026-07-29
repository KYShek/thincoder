Run the appropriate linter/checker for a file. Auto-detects based on file extension and project config.

Parameters:
- path (optional): File to check (default: most recently modified file)

Supported languages:
- .js/.mjs/.cjs/.jsx: eslint (if config present) → node --check (built-in, always available)
- .ts/.tsx/.mts/.cts: eslint → tsc --noEmit (if tsconfig.json present) → node --check
- .py: ruff (if installed)
- .rs: cargo check (if Cargo.toml present)
- .go: go vet

Does NOT install anything — only uses tools already available in the project.