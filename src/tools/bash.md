Execute a shell command and return stdout+stderr. Use for running commands, builds, tests.

Parameters:
- command (required): Shell command to execute
- timeout: Timeout in milliseconds (default 120000, max ~300000)

Notes:
- There is NO TTY — editors, pagers (vim, less), and interactive prompts WILL hang. Always pass non-interactive flags: `git commit -m`, `git --no-pager`, `-y`/`--yes` where applicable
- The environment sets GIT_PAGER=cat, PAGER=cat, EDITOR=true, TERM=dumb — but still always use non-interactive flags
- Output is capped at ~50000 chars; if you need more, redirect to a file and read it
- On Windows, use Unix shell syntax inside bash commands (Git Bash): forward slashes, `/dev/null` not `NUL`
- Never use bash to read, copy, or transmit secret files (.env, keys, tokens)
- Do NOT run destructive commands (rm -rf, force-push, drop table) without explicit user confirmation
- After commands that change files (git checkout, npm install, etc.), repo_outline and code_search may be stale — re-run them to get current results.
