# RC10 human terminal acceptance worksheet

**Status: PENDING HUMAN EXECUTION.** This is a blank worksheet. No terminal matrix cell has been run or accepted by this document.

## Candidate identity to verify on the operator host

- Tag: `v1.0.0-rc.10`
- Full source commit: `16ee8ca3643824741b6da67936b41f262414fdf0`
- Linux x86_64 archive: `nexus-linux-x86_64-v1.0.0-rc.10.tar.gz`
- Published archive SHA-256: `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`
- Release: https://github.com/mikeholownych/nexus-code/releases/tag/v1.0.0-rc.10

The operator must install the published artifact on the host used for this matrix, then record the installed `nexus --version`, archive digest, installation location, host, and UTC time below. Do not use a checkout build or a different RC.

| Operator record | Value |
|---|---|
| Operator | |
| UTC date/time | |
| Host OS and version | |
| Installed artifact location | |
| Installed archive filename | |
| Installed archive SHA-256 | |
| `nexus --version` output | |
| xterm version | |
| kitty version and keyboard protocol state | |
| tmux version / GNOME Terminal host version | |
| VS Code version / integrated terminal profile | |
| GNOME Terminal version | |
| Evidence directory | |

## Run procedure for every cell

Follow [`ACCEPTANCE.md` §5.3](../../../../../v1.0.0/ACCEPTANCE.md#53-manual-real-terminal-matrix-e3) against the installed candidate at the exact terminal and size listed in the row.

1. Launch Nexus and confirm the live TUI appears.
2. At the approval panel, type continuously across it, paste three lines, then approve with a deliberate key.
3. Exercise multiline input with Shift+Enter or Alt+Enter.
4. Resize during streaming.
5. Press Esc during `sleep 30`; confirm no child processes survive.
6. Press Ctrl-C twice; confirm terminal echo and display restore without stray escape codes.
7. Exercise `NO_COLOR`.

For each row, attach a genuine screenshot of the approval panel and a genuine screenshot of the restored post-exit terminal. Record exact observations, commands where applicable, and any failure disposition. Automated PTY evidence does not fill these manual rows.

## Terminal × size matrix

Each cell remains pending until the operator performs the procedure and records both screenshots. Mark exactly one verdict per cell.

| # | Terminal | Size | Verdict | Evidence / result reference | Approval screenshot | Post-exit screenshot | Notes / failure disposition |
|---:|---|---:|---|---|---|---|---|
| 1 | xterm | 80×24 | PENDING | | | | |
| 2 | xterm | 40×14 | PENDING | | | | |
| 3 | xterm | 200×60 | PENDING | | | | |
| 4 | kitty (kitty keyboard protocol on) | 80×24 | PENDING | | | | |
| 5 | kitty (kitty keyboard protocol on) | 40×14 | PENDING | | | | |
| 6 | kitty (kitty keyboard protocol on) | 200×60 | PENDING | | | | |
| 7 | tmux 3.x inside GNOME Terminal | 80×24 | PENDING | | | | |
| 8 | tmux 3.x inside GNOME Terminal | 40×14 | PENDING | | | | |
| 9 | tmux 3.x inside GNOME Terminal | 200×60 | PENDING | | | | |
| 10 | VS Code integrated terminal | 80×24 | PENDING | | | | |
| 11 | VS Code integrated terminal | 40×14 | PENDING | | | | |
| 12 | VS Code integrated terminal | 200×60 | PENDING | | | | |
| 13 | GNOME Terminal | 80×24 | PENDING | | | | |
| 14 | GNOME Terminal | 40×14 | PENDING | | | | |
| 15 | GNOME Terminal | 200×60 | PENDING | | | | |

## Operator disposition

- Completed cells: `0 / 15`
- Overall result: `PENDING`
- Operator acceptance and UTC timestamp: __________________________________
- Open failures or limitations: ___________________________________________

Do not change the overall result to PASS until all 15 cells contain operator verdicts and the required screenshot references, then apply the acceptance rules in `ACCEPTANCE.md` §5.3.
