# Manual real-terminal acceptance worksheet

For `REQ-QUAL-108` / `ACC-TUI-MANUAL`, following [`ACCEPTANCE.md` §5.3](ACCEPTANCE.md#53-manual-real-terminal-matrix-e3).

> **Required for v1.0.0.** Complete all 15 cells against the exact installed RC. Blank cells are incomplete; no result is inferred. Automated PTY runs do not count as manual cell evidence. DEC-18 waives screenshot artifacts only. The prior waiver record is withdrawn by [DEC-19](DECISIONS.md#dec-19-v100-manual-terminal-matrix-waiver).

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
- Per-cell evidence record directory or reference: ________

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

Screenshot artifacts are waived for v1.0.0 per [DEC-18](DECISIONS.md#dec-18-v100-terminal-screenshot-artifact-waiver). This does not waive any live manual interaction, check, observation, per-cell verdict, or evidence record. Automated PTY runs do not count as completion of these manual real-terminal cells.

## Terminal × size results

Select exactly one PASS or FAIL for each cell. Record observed outcomes for every check and a per-cell evidence reference bound to the installed RC identity, terminal environment, and size. Record failures in the disposition/notes field.

| # | Terminal environment | Size | Verdict (select one) | Per-cell evidence / result reference | Failure disposition / notes |
|---:|---|---:|---|---|---|
| 1 | xterm | 80×24 | [ ] PASS  [ ] FAIL | | |
| 2 | xterm | 40×14 | [ ] PASS  [ ] FAIL | | |
| 3 | xterm | 200×60 | [ ] PASS  [ ] FAIL | | |
| 4 | kitty (kitty keyboard protocol on) | 80×24 | [ ] PASS  [ ] FAIL | | |
| 5 | kitty (kitty keyboard protocol on) | 40×14 | [ ] PASS  [ ] FAIL | | |
| 6 | kitty (kitty keyboard protocol on) | 200×60 | [ ] PASS  [ ] FAIL | | |
| 7 | tmux 3.x inside GNOME Terminal | 80×24 | [ ] PASS  [ ] FAIL | | |
| 8 | tmux 3.x inside GNOME Terminal | 40×14 | [ ] PASS  [ ] FAIL | | |
| 9 | tmux 3.x inside GNOME Terminal | 200×60 | [ ] PASS  [ ] FAIL | | |
| 10 | VS Code integrated terminal | 80×24 | [ ] PASS  [ ] FAIL | | |
| 11 | VS Code integrated terminal | 40×14 | [ ] PASS  [ ] FAIL | | |
| 12 | VS Code integrated terminal | 200×60 | [ ] PASS  [ ] FAIL | | |
| 13 | GNOME Terminal | 80×24 | [ ] PASS  [ ] FAIL | | |
| 14 | GNOME Terminal | 40×14 | [ ] PASS  [ ] FAIL | | |
| 15 | GNOME Terminal | 200×60 | [ ] PASS  [ ] FAIL | | |

## Acceptance gate

- Safety checks 2, 5, and 6: **zero failures across all 15 cells**. Any failure here blocks this gate.
- Any failure on another check requires a written disposition: fix, or a documented known limitation.
- All 15 cells have exactly one verdict, check outcomes, and per-cell evidence references: [ ] yes  [ ] no
- All non-safety failures have a written disposition: [ ] yes  [ ] no  [ ] no such failures
- Safety gate has zero failures: [ ] yes  [ ] no

§5.3 matrix gate: [ ] PASS  [ ] FAIL  [ ] INCOMPLETE

Mark the §5.3 matrix gate PASS when all 15 verdicts, check outcomes, and per-cell evidence
references are complete, checks 2, 5, and 6 have zero failures, and every
failure on another check has a written disposition. Mark it FAIL if any safety
check (2, 5, or 6) failed. Mark it INCOMPLETE when required evidence is missing
or a non-safety failure has no written disposition.

ACC-TUI-MANUAL: [ ] PASS  [ ] FAIL  [ ] INCOMPLETE

Mark ACC-TUI-MANUAL PASS only when all 15 cell verdicts are PASS and the
per-cell outcomes and evidence records are complete. Screenshots are waived per DEC-18. Mark it FAIL if any
cell is FAIL. Mark it INCOMPLETE when evidence is missing and no cell has
failed. A documented known limitation for a non-safety failure may satisfy the
§5.3 disposition requirement, but the cell remains FAIL and ACC-TUI-MANUAL
remains unmet until every cell passes.

Operator summary / evidence index: ______________________________________________

This worksheet records manual terminal evidence only. It does not replace the separate CI PTY, installed-RC, or independent acceptance gates in `ACCEPTANCE.md`.
