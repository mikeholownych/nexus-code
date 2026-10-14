# Lessons

- 2026-10-12 — Concurrent edits in the checkout after a rate-limit pause may come from an agent the operator started
  to continue *my* work, not from an unrelated actor. Before treating them as foreign (splitting them off, excluding
  them from commits), ask whether a continuation agent was used and read its summary; then fold its work into the
  plan and verify it like my own.
- 2026-10-13 — Another agent (Cursor) committed to the same branch while I worked; my evidence commit then replaced its
  newer evidence. A clean `git status` is not enough: before every commit, check `git log -1` against the commit I last
  made (and `git log ORIG..HEAD` for foreign commits); if HEAD moved, stop and reconcile — never commit generated
  artefacts (evidence, dist) over a branch that moved.

## 2026-10-13 — eval harness (self-caught)
- Paths handed to a spawned agent (CA bundles, output dirs) must be absolute: the agent runs with another cwd. Resolve
  `--out` once at startup.
- Set `PWD` (and XDG dirs) explicitly for spawned tools: some take the project from an inherited `$PWD`, not the
  process cwd — OpenCode edited the task fixture this way.
- Never `pkill -f <pattern>` from a shell whose own command line contains the pattern (it kills itself); node runners
  show as `MainThread` in `comm`, so filter by PID from `ps -eo pid,args`.
- Monitor filters on outcomes: `VERIFIED` is a substring of `UNVERIFIED`; anchor (`: VERIFIED `).
- Run a smoke pass of every adapter with the exact runner invocation (relative paths included) before scored runs.

## 2026-10-13 — compaction/continuity session
- Repeated the `pkill -f <pattern>` self-kill (exit 144) despite the 2026-10-13 lesson above. Rule: never use `pkill -f`
  at all; stop background work with TaskStop, or kill by PID taken from `ps -eo pid,args` filtered with `grep -v grep`.
- HEAD of the operator's checkout moved (reset to origin/main, stash, foreign uncommitted edits) during a usage-limit
  pause. Verified what landed before acting, then worked in an isolated worktree instead of on top of edits I could not
  attribute.
- A full test run reads `src/` live (tsx): editing sources while it runs contaminates results. Run long suites on a
  snapshot copy of the tree, and keep editing the worktree.
