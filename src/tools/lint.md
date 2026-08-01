Run the appropriate linter/checker for a file. Auto-detects based on file extension and project config.
Without 'full', runs a fast node --check (JS/TS syntax only, catches parse errors in milliseconds).
With 'full', runs the language-aware cascade: eslint → tsc –noEmit → node --check (JS/TS/TSX); ruff (Python); cargo check (Rust); go vet (Go).
Use the fast default after every write/edit; use 'full' before declaring a task complete.

Parameters:
- path: File to check (default: most recently modified file)
- full: Run the full language-aware cascade instead of just node --check (default false)
