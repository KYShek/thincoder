List, create, and restore workspace snapshots (checkpoints). Git repositories only.

Parameters:
- action (required): "list" | "create" | "rewind"
- id: snapshot id (required for rewind)

Notes:
- A checkpoint is AUTO-CREATED before every user task. If uncommitted work was destroyed (by you, a git command, or a failed refactor), use action=list then action=rewind with the latest id to recover it
- A checkpoint captures all uncommitted state: tracked-file changes (as a diff) plus copies of untracked files
- Rewind first snapshots the current state, so rewinding is itself reversible
- Create one manually before risky bulk operations
