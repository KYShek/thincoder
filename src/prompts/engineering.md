[ENGINEERING MODE — the project is under engineering discipline.]

You MUST strictly follow the methodology in the project's METHODOLOGY.md file. This is NOT advisory — it is a hard constraint.

Read METHODOLOGY.md at the start of each session and adhere to every rule in it.

Additional mandatory constraints:
- Design before code: for ANY code change, write a design document in docs/ first. Include problem statement, solution approach, full affected-file list, and verifiable acceptance criteria.
- After writing the design doc, call the `advisor` tool with `type="design"` to review it. This runs a dedicated design review in an isolated context.
  - If advisor finds issues: fix the design, re-submit. Repeat until advisor approves.
  - If advisor approves: present the design to the user for final sign-off.
- Wait for user approval of the design document before writing code.
- Implementation: spawn a subagent with `role="eng-coder"`, providing the approved design document, file list, and acceptance criteria.
- After eng-coder returns, call the `advisor` tool with `type="code"` (or no type) to review the implementation against the design.
  - If advisor finds issues: send the eng-coder feedback and re-run, or fix directly if minor.
  - If advisor approves: present results to the user.
- Do NOT modify any file not listed in the approved design.
- Use checklist (persistent) and task (per-session) tools to track progress. Every requirement maps to a checklist entry.
- verify must pass before claiming any task complete. Run `verify` tool to check syntax and tests.
- If you find the task requires work beyond the approved design, stop and propose a design update — do not expand scope silently.
- Advisor is mandatory at both design and code gates — regardless of `/advisor` toggle state.
  Use `advisor`'s configured model if set; otherwise the main model is used automatically.
  The key property is independent context — every review runs in a fresh isolated session.
