# Manual real-terminal acceptance worksheet

For `REQ-QUAL-108` / `ACC-TUI-MANUAL`, following [`ACCEPTANCE.md` §5.3](ACCEPTANCE.md#53-manual-real-terminal-matrix-e3).

> **Waived for v1.0.0 by DEC-20.** No cell runs or evidence are required, and no cell result is inferred. Blank cells are not a release blocker. The worksheet remains available for optional operator checks. Automated CI (§5.1) and scripted PTY (§5.2) gates remain mandatory.

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

For v1.0.0, manual runs are waived by [DEC-20](DECISIONS.md#dec-20-v100-manual-terminal-matrix-waiver). If optional manual checks are performed, record only what was actually observed. Such checks do not replace mandatory automated CI (§5.1) or scripted PTY (§5.2) evidence.

## Partial operator report

In response to the RC10 matrix request, the release owner reported that the client rendered at the tested sizes except in tmux inside GNOME Terminal; that setup could not be resized below 43×13, and the other results seemed okay. The report was received on 2026-10-29; test time, exact installed artifact identity, terminal versions, and per-cell check outcomes were not supplied. Treat this as useful partial operator information only: it does not fill any matrix cell or establish the installed-RC gate. No screenshot was supplied; DEC-18 waives screenshot artifacts.

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

## Optional observation summary

- If optional checks are performed, record outcomes and failures truthfully; do not infer missing results.
- This worksheet does not establish acceptance of mandatory automated CI (§5.1) or scripted PTY (§5.2) gates.

§5.3 matrix disposition: WAIVED for v1.0.0 by DEC-20. Optional observations do not change that disposition.

Operator summary / evidence index: ______________________________________________

This worksheet records manual terminal evidence only. It does not replace the separate CI PTY, installed-RC, or independent acceptance gates in `ACCEPTANCE.md`.
