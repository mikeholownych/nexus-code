# TUI audit status (v1.1.4, WP-1317)

Status of each defect in [TUI-AUDIT.md](https://github.com/mikeholownych/nexus-code/blob/v1/v114-tui-audit/docs/v1.1.4/TUI-AUDIT.md)
(branch `v1/v114-tui-audit`). One row per defect: FIXED with the commit and the regression test, or the limitation
stated precisely. Captures live under `docs/evidence/v1.1.4/tui/<defect>/`.

| Defect | Sev | Status | Commit | Regression test | Notes |
|---|---|---|---|---|---|
| D-03 | major | FIXED | `5d7afecd`, `2924ab86`, `bfd7e8f9`, `d942d808`, `b30a107b`, `8a5b29cc` | `cli/test/nexus_state_not_dirty.test.ts` (12 cases) | Header, `[Git Status]`, `/git`, `/commit` read one status that excludes `.nexus` (the workspace's and the repository root's), and `/commit` unstages and excludes the same set; receipts write `.nexus/.gitignore`; `/diff` names untracked or staged files instead of calling the tree clean; `--read-only` writes no receipts to the workspace. Limitation: a file the user deliberately tracks under `.nexus/` is no longer reported as changed by any Nexus surface (`/commit` already skipped it); `git status` still shows it. |
| D-04 | major | FIXED | `8576ce14`, `9b27bef8`, `10e64cfc` | `cli/test/turn_verdict_evidence.test.ts` (6 cases, real review-mode turns); Rust `live_state::tests::the_verdict_describes_this_turns_own_evidence` | The turn result carries `turnEvidence` (workspace changed this turn, changes carried in, denials, verifier runs); the TUI verdict and the REPL line read it. A turn whose commands leave the workspace exactly as found and carries nothing in is `NOT_REQUIRED` (`nexus run` exits 0, lead-approved); a command that writes stays `UNVERIFIED`. Limitation: "changed" is the workspace state identity, so a command that changes only files that identity does not cover is not seen (FINDINGS §H). |
