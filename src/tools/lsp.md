LSP code intelligence: go to definition, find references, hover info, document symbols, diagnostics. Use this to understand code structure without grep-guessing function locations or type shapes.

Parameters:
- subcommand (required): LSP operation — "definition" | "references" | "hover" | "symbols" | "diagnostics"
- uri (required): Target file path (relative to project root)
- line: 1-based line number (for definition/references/hover)
- character: 1-based character offset (for definition/references/hover)
