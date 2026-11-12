# D-15 /resume with no argument

Produced by `tui_polish_capture.py` (this directory's parent) with a pseudo-terminal; `before` = `origin/v1/v114-int-4` 69067429 (TUI binary and cli built from `git archive` of that commit), `after` = the commit that fixes the defect on `v1/v114-pol-g2` (see TUI-AUDIT-STATUS.md). Command: `tui_polish_capture.py DEFECT TUI_BINARY CLI_DIR before|after OUTDIR`. Real TUI and real sidecar against a fake model: one prompt (`say hello`) so one session is saved and in use, then `/sessions` and `/resume`.

- `before.txt`: `/resume` reloads the starred (current) session: `Resumed session session_...` (the conversation is replayed).
- `after.txt`: `There is no other saved session to resume (the one you are in is already loaded). /sessions lists what is saved; /resume <id> loads one.`
- With another saved session, `/resume` loads the most recent one other than the current (unit test `slash_resume_other.test.ts`; not captured in the pty). `/resume <id>`, `/resume latest` and `--resume` at start-up are unchanged.
- `unit-red-before.txt`: the new tests before the fix.
