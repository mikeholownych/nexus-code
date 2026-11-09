# TUI audit status (v1.1.4, WP-1317)

Status of each defect in [TUI-AUDIT.md](https://github.com/mikeholownych/nexus-code/blob/v1/v114-tui-audit/docs/v1.1.4/TUI-AUDIT.md)
(branch `v1/v114-tui-audit`). One row per defect: FIXED with the commit and the regression test, or the limitation
stated precisely. Captures live under `docs/evidence/v1.1.4/tui/<defect>/`.

| Defect | Sev | Status | Commit | Regression test | Notes |
|---|---|---|---|---|---|
| D-03 | major | FIXED | `5d7afecd`, `2924ab86`, `bfd7e8f9`, `d942d808`, `b30a107b` | `cli/test/nexus_state_not_dirty.test.ts` (11 cases) | Header, `[Git Status]`, `/git`, `/commit` read one status that excludes `.nexus` (the workspace's and the repository root's), and `/commit` unstages and excludes the same set; receipts write `.nexus/.gitignore`; `/diff` names untracked or staged files instead of calling the tree clean; `--read-only` writes no receipts to the workspace. Limitations: REPL `/git` still shows a pre-existing `.nexus/` until the next turn (FINDINGS §F, fixed with D-04). A file the user deliberately tracks under `.nexus/` is no longer reported as changed by any Nexus surface (`/commit` already skipped it); `git status` still shows it. |
