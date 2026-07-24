Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.

Parameters:
- path (required): File path
- old_string (required): Exact text to find and replace
- new_string (required): Replacement text
- replace_all: Replace all occurrences instead of just one (default false)

Notes:
- Prefer this over write for targeted edits — it's safer and keeps diffs small
- If old_string matches zero times: error. If it matches multiple times without replace_all: error — add more surrounding context to make it unique
- Never fabricate the old_string — copy it verbatim from the actual file using read first
