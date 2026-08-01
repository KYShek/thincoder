Apply a unified diff to one or more files, atomically: if any hunk fails to apply, nothing is written.

Parameters:
- patch (required): Unified diff text. One `--- a/path` / `+++ b/path` header pair per file, then `@@ -old,count +new,count @@` hunks. Use `--- /dev/null` to create a new file.

Notes:
- Use this for multi-file changes (e.g. rename an interface + update all callers) — one call, all-or-nothing
- Hunks are located by their context/removed lines, not line numbers — but the context must match the file EXACTLY. Read the files first and generate the patch from actual content
- If a hunk's context matches multiple locations it is rejected — add more surrounding context lines
- Deleting files is not supported — use the delete tool
- For single-file edits, edit is simpler; for full rewrites, write is simpler
