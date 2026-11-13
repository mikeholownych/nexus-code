# D-18 messages typed while the agent works

Produced by `tui_polish_capture_g2.py` (this directory's parent) with a pseudo-terminal; `before` = `origin/v1/v114-int-4` 69067429 (TUI binary and cli built from `git archive` of that commit), `after` = the commit that fixes the defect on `v1/v114-pol-g2` (see TUI-AUDIT-STATUS.md). Command: `tui_polish_capture_g2.py DEFECT TUI_BINARY CLI_DIR before|after OUTDIR`. Scripted sidecar (acknowledges steering as `queued`, and on `cancel` returns each as `cancelled`); the agent is in a provider wait; two messages are typed (Enter each), then Esc, then Enter.

Decision: Enter while the agent works stays steering for the running turn (it joins that turn at its next step; there is still no separate "queue a next prompt" command). What changed is that nothing is joined without saying so:
- the steering row says what will happen to each message (`applies at the next step`, or `runs as its own turn next` for one sent as the turn ends); `before` said `queued for the next step`;
- messages deferred as the turn ends now run one follow-up turn each, in order, not joined into one user message (sidecar; TS test);
- when returned messages end up in one draft, a notice says Enter sends the draft as one message (`after.txt`: `! Another message was added to the draft; Enter sends the whole draft as one message; edit the draft if you want them sent separately.`). The draft still sends as one prompt if the operator presses Enter: it is the operator's text, now announced.
- `before.txt` shows the audit behaviour (both returned, joined, sent as `SC:e500 go\nSC:reset go` with no word about it).
- #469's burst/guard code is untouched: steering text goes through the same composer and `submit_while_busy` path.
- `unit-red-before.txt`: tests before the fix.
