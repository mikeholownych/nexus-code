# D-05 context indicator and the header across widths

`before.txt` is a build of `origin/v1/v114-int-4` 69067429 (main plus D-01..D-10 and the #476 surface facts, before the
D-05 change; a `v1.1.3`-equivalent build was not needed). `after.txt` is this branch. Both are produced by
`python3 docs/evidence/v1.1.4/tui/tui_status_capture.py d05 <nexus-tui binary> <label>`: the real `nexus-tui --live` in a
pseudo-terminal with a fake sidecar sending a `session.state` with the facts a session has after its first turn
(2 files changed, 11381 of 65536 tokens of context, a `session_YYYYMMDD_HHMMSS_xxxxxxxx` id, posture, endpoint kind).
`unit-red-before.txt` is the new Rust tests run against the old `render_status` (3 of 4 fail; the 4th is the protocol
parse test, added without a code change).

What the status bar drops, in order (last dropped first), from the code and the captures:
workspace, mode and `read-only` (never dropped), model, `ctx N%`, branch, `sandbox/workspace` trust, session id,
endpoint kind (`local`/`cloud`). The counts `context used/limit · N%` replace `ctx N%` only when room is left.

- Before: at 80x24 the context figure was dropped as soon as the first turn added `●2 changed` to the branch
  (`context 0/65536` was shown on the first frame, nothing after the turn). At 100 columns the counts shown had no percent.
- After: the percent survives at 80x24 and 100x30 after the first turn (`ctx 17%`), at 160 columns the session id and
  trust remain beside it; at 50x15 the header is `NEXUS app model engineering/b0 mode: review`: branch, context
  and endpoint do not fit (the model name is longer than the room left, a documented limit).
- Session id: it was never removed by the first turn in the code (`session.state` repeats it); it is shown whole or not
  at all (never cut, it is what `/resume` takes) and needs about 140 columns beside the other segments, so it shows at
  160 columns before and after the first turn and not at 100.
- Cost: not shown. The `session.state` event carries no cost; the only cost data is the cloud usage ledger
  (`cli/src/usage.ts`, provider-reported and often unknown), outside the sidecar's session facts. Adding it would need a
  new protocol field and a decision on unpriced providers. The audit says "ideally".
