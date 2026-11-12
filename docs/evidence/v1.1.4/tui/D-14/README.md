# D-14 status wording

Produced by `tui_polish_capture_g2.py` (this directory's parent) with a pseudo-terminal; `before` = `origin/v1/v114-int-4` 69067429 (TUI binary and cli built from `git archive` of that commit), `after` = the commit that fixes the defect on `v1/v114-pol-g2` (see TUI-AUDIT-STATUS.md). Command: `tui_polish_capture_g2.py DEFECT TUI_BINARY CLI_DIR before|after OUTDIR`. Scripted sidecar events (the TUI binary is the real one): (a) `activity inference` then an `assistant.delta`, (b) `activity verifying` with the controller's label `npm test (before the change)`, (c) a cancelled turn interrupted in `tool_settling`. 100, 60 and 40 columns for (a) and (b).

- `before.txt`: `thinking · 0:00` while text is on screen; `verifying (npm test (before the change))`; `You stopped the turn during tool settling.`
- `after.txt`: `writing`; `checking npm test before your change`; `You stopped the turn while a tool was finishing.`
- The phase protocol (`activity.phase` values and the controller's `tool` labels) is unchanged; only the TUI wording changed. (d) from the audit (the `waiting for the agent` spinner on slash commands) is not changed.
- At 40 columns the status line is clipped by the existing line fitting (`esc c…`), before and after.
- `unit-red-before.txt`: Rust tests before the fix.
