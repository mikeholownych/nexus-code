# RC10 installed terminal accessibility state probe

Candidate: `v1.0.0-rc.10`, source `16ee8ca3643824741b6da67936b41f262414fdf0`, Linux x86_64 archive SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`. The installed package was invoked through its installed TUI launcher. Each workspace and outer HOME/XDG tree was isolated. Gateway and workspace contents were synthetic; no credentials, held-out tasks, or provider access were used.

## Scope and result

The scripted probe sampled ten readable UI states: idle, help, model picker, streaming, cancelled turn, approval, completion, tool running, tool cancellation, and endpoint error. It exercised `xterm-256color` with `NO_COLOR=1` and `TERM=dumb` with `NO_COLOR` unset, each at 40×14 and 100×30. Raw PTY streams and decoded screen snapshots are preserved per attempt.

| Configuration | First attempt | Confirmation attempt |
|---|---|---|
| xterm-256color + NO_COLOR=1, 40×14 | 10 sampled states passed | 10 sampled states passed |
| xterm-256color + NO_COLOR=1, 100×30 | 10 sampled states passed | 10 sampled states passed |
| TERM=dumb, 40×14 | 10 sampled states passed | 10 sampled states passed |
| TERM=dumb, 100×30 | tool cancellation remained in `cancelling` beyond 5 s | tool cancellation remained in `cancelling` beyond 5 s |

An isolated retry of the TERM=dumb 100×30 tool-cancel subcase returned to idle about 0.4 s after Esc. This does not erase the two full-matrix timeouts: the behavior is intermittent. The failure screen says `cancelling — waiting for run_command (5s)` and keeps the running turn visible. All retained raw streams were scanned for color-setting SGR parameters; none were found. The 40-column approval snapshots show the complete decision hint `←→ choose, enter · esc denies`.

## Disposition

`PARTIAL_NOT_ACCEPTED`. These captures establish sampled-state readability and no color-setting SGR in the captured streams, but do not establish the full ACC-TUI-A11Y criterion. In addition to the intermittent Esc/tool-cancellation delay, the nine `Overlay` variants in source were not all exercised; checkpoint choice, detail, receipt, connect, paste, and review overlays remain outside this probe. The required real-terminal human matrix remains separate. Do not treat this as accepted accessibility qualification.

The two failed full-matrix attempts, the successful isolated retry, their runner scripts, synthetic gateway logs, PTY streams, and screen snapshots are retained here without replacing earlier attempts.

## Supplemental overlay-state probe (2026-10-27)

A later installed-RC10 synthetic probe rendered eight of the nine source `Overlay` variants at `TERM=dumb`, 40×14. The `Detail` overlay was not captured. Follow-up attempts displayed the command approval panel but did not complete the synthetic approval sequence; they are classified as harness-incomplete, not product failures. Raw streams, screenshots, driver, mock gateway and attempts are archived under [overlay-expansion-20261027](overlay-expansion-20261027/README.md). This narrows the earlier overlay-coverage gap but does not change the overall `PARTIAL_NOT_ACCEPTED` disposition: other terminal configurations are uncovered, the intermittent cancellation timeouts remain, and human terminal acceptance remains pending.
