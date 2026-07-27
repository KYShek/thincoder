List, create, and restore workspace snapshots (checkpoints). Git repositories only.

Parameters:
- action (required): "list" | "create" | "rewind"
- id: snapshot id (required for rewind)
- path: restore only this single file from the checkpoint (tracked or untracked). Other files are left untouched.

Notes:
- A checkpoint is AUTO-CREATED before every user task. If uncommitted work was destroyed (by you, a git command, or a failed refactor), use action=list then action=rewind with the latest id to recover it
- A checkpoint captures all uncommitted state: tracked-file changes (as a diff) plus copies of untracked files
- Rewind first snapshots the current state, so rewinding is itself reversible
- Rewind AUTO-RECOVERS: if git apply fails (corrupt patch), the pre-rewind state is restored — never lose data
- Create one manually before risky bulk operations
- list now shows which files changed (tracked + untracked); use path to recover individual files selectively
