Show git diff (unified format). Use to see uncommitted changes, staged changes, or diff against a specific ref.

Parameters:
- staged: Show staged changes (default false, shows working tree diff)
- path: File or directory to diff (default all)
- ref: Compare against a ref (default HEAD)

Notes:
- Only works inside a git repository
- Output is standard unified diff — LLMs understand this natively
- If no changes, returns "(no changes)"
