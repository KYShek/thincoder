Run a git command. Use this to see uncommitted changes, staged changes, diff against a ref, recent commits, or manage checkpoints. Only works inside a git repository.
- action='diff': Show unified diff — what changed since last commit. Set staged=true for staged-only diff, ref=<ref> to compare against a specific commit/branch, path=<dir> to scope to a file or directory.
- action='status': Show working tree state — staged, unstaged, untracked files, and conflicts. Returns categorized lists.
- action='log': Show recent commit history. Set count to limit, oneline=true for compact format, path=<file> to see history of one file.
- action='checkpoint': Manage git-based snapshots. Use checkpointAction to choose: list (overview), create (snapshot now), rewind (restore snapshot by id), cat (read a file from a snapshot).

Parameters:
- action (required): diff / status / log / checkpoint
- staged: (diff) Show staged changes instead of working tree
- path: (diff/log/checkpoint:cat/checkpoint:rewind) File or directory to scope to
- ref: (diff) Compare against this ref (default HEAD)
- count: (log) Number of commits (default 10)
- oneline: (log) One-line-per-commit format
- checkpointAction: (checkpoint) list snapshots / create one / restore by id / read file from snapshot
- checkpointId: (checkpoint) Snapshot id — required for rewind and cat; optional for list (shows file tree)
