# Manual real-terminal acceptance worksheet

For `REQ-QUAL-108` / `ACC-TUI-MANUAL`, following [`ACCEPTANCE.md` §5.3](ACCEPTANCE.md#53-manual-real-terminal-matrix-e3). This is an unfilled recording template; it contains no test results and does not qualify an RC.

## Installed candidate identity

Fill these fields from the installed candidate before the first cell. Do not copy identity from a source branch or local build.

- RC tag: ______________________________________________
- Full RC source commit: ________________________________
- Installed package/archive name and location: ____________
- Installed artifact SHA256: ____________________________
- Installation procedure/run reference: __________________
- `nexus --version` output reference: ____________________
- Operator and UTC date/time: ____________________________
- Host OS and version: __________________________________
- Screen capture evidence directory: _____________________

Record the actual terminal versions/protocol configuration used. Kitty must have the kitty keyboard protocol on; record the tmux 3.x version and its GNOME Terminal host version.

| Environment | Version / protocol details |
|---|---|
| xterm | |
| kitty (kitty keyboard protocol on) | |
| tmux 3.x inside GNOME Terminal | tmux: ; GNOME Terminal: |
| VS Code integrated terminal | VS Code: ; integrated terminal profile: |
| GNOME Terminal | |

## Procedure to perform in every matrix cell

Run each step against the installed candidate in the terminal and size named by that row. Record the observations and evidence references for the cell.

1. Launch `nexus`; confirm the TUI appears.
2. At the approval panel, type continuously across it, paste 3 lines, then approve with a deliberate key.
3. Exercise multiline input with Shift+Enter or Alt+Enter.
4. Resize during streaming.
5. Press Esc during `sleep 30`; confirm no child processes survive.
6. Press Ctrl-C twice; confirm clean terminal restoration (echo on, no stray escape codes).
7. Exercise `NO_COLOR`.

For each cell, archive a screenshot of the approval panel and a screenshot of the post-exit terminal state. Record a separate evidence/result reference where useful. Automated PTY runs and screenshots do not count as completion of these manual real-terminal cells.

## Terminal × size results

Select exactly one PASS or FAIL for each cell. Add the approval-panel and post-exit screenshot references for every cell. Record failures in the disposition/notes field.

| # | Terminal environment | Size | Verdict (select one) | Evidence / result reference | Approval-panel screenshot | Post-exit screenshot | Failure disposition / notes |
|---:|---|---:|---|---|---|---|---|
| 1 | xterm | 80×24 | [ ] PASS  [ ] FAIL | | | | |
| 2 | xterm | 40×14 | [ ] PASS  [ ] FAIL | | | | |
| 3 | xterm | 200×60 | [ ] PASS  [ ] FAIL | | | | |
| 4 | kitty (kitty keyboard protocol on) | 80×24 | [ ] PASS  [ ] FAIL | | | | |
| 5 | kitty (kitty keyboard protocol on) | 40×14 | [ ] PASS  [ ] FAIL | | | | |
| 6 | kitty (kitty keyboard protocol on) | 200×60 | [ ] PASS  [ ] FAIL | | | | |
| 7 | tmux 3.x inside GNOME Terminal | 80×24 | [ ] PASS  [ ] FAIL | | | | |
| 8 | tmux 3.x inside GNOME Terminal | 40×14 | [ ] PASS  [ ] FAIL | | | | |
| 9 | tmux 3.x inside GNOME Terminal | 200×60 | [ ] PASS  [ ] FAIL | | | | |
| 10 | VS Code integrated terminal | 80×24 | [ ] PASS  [ ] FAIL | | | | |
| 11 | VS Code integrated terminal | 40×14 | [ ] PASS  [ ] FAIL | | | | |
| 12 | VS Code integrated terminal | 200×60 | [ ] PASS  [ ] FAIL | | | | |
| 13 | GNOME Terminal | 80×24 | [ ] PASS  [ ] FAIL | | | | |
| 14 | GNOME Terminal | 40×14 | [ ] PASS  [ ] FAIL | | | | |
| 15 | GNOME Terminal | 200×60 | [ ] PASS  [ ] FAIL | | | | |

## Acceptance gate

- Safety checks 2, 5, and 6: **zero failures across all 15 cells**. Any failure here blocks this gate.
- Any failure on another check requires a written disposition: fix, or a documented known limitation.
- All 15 cells have exactly one verdict and both required screenshots are referenced: [ ] yes  [ ] no
- All non-safety failures have a written disposition: [ ] yes  [ ] no  [ ] no such failures
- Safety gate has zero failures: [ ] yes  [ ] no

§5.3 matrix gate: [ ] PASS  [ ] FAIL  [ ] INCOMPLETE

Mark the §5.3 matrix gate PASS when all 15 verdicts, screenshots, and evidence
references are complete, checks 2, 5, and 6 have zero failures, and every
failure on another check has a written disposition. Mark it FAIL if any safety
check (2, 5, or 6) failed. Mark it INCOMPLETE when required evidence is missing
or a non-safety failure has no written disposition.

ACC-TUI-MANUAL: [ ] PASS  [ ] FAIL  [ ] INCOMPLETE

Mark ACC-TUI-MANUAL PASS only when all 15 cell verdicts are PASS and the
required screenshots and per-cell evidence are archived. Mark it FAIL if any
cell is FAIL. Mark it INCOMPLETE when evidence is missing and no cell has
failed. A documented known limitation for a non-safety failure may satisfy the
§5.3 disposition requirement, but the cell remains FAIL and ACC-TUI-MANUAL
remains unmet until every cell passes.

Operator summary / evidence index: ______________________________________________

This worksheet records manual terminal evidence only. It does not replace the separate CI PTY, installed-RC, or independent acceptance gates in `ACCEPTANCE.md`.
