# D-12 captures

`python3 docs/evidence/v1.1.4/tui/tui_polish_capture.py D-12 before|after <nexus-tui binary> 69067429`. The real `nexus-tui --live`
(built from this branch) runs in a pty (`tui_input_capture.py`'s `Term`) against a fake sidecar script that sends the events the
real sidecar sends: a `delete_file` call, its approval request, and (after the TUI sends `deny`) the `tool.end`. The audit's 16.6 s
wait is sent as `duration_ms:16600`, as the integration branch's sidecar reported it. Pressed `n` after the panel's 1 s input guard.
Captured at 100x24 and 40x24.

- `before.txt`: the `tool.end` the integration branch (`69067429`) sends (model-facing sentence, no flag). A TUI that does not
  know the new flag draws exactly this (the unit test `a_denied_call_says_denied_by_you_...` pins that a `tool.end` without
  `denied` keeps its words and run time), so this branch's binary stands in for the old one.
- `after.txt`: the `tool.end` this branch's sidecar sends (`summary "Denied by you"`, `denied:true`): `× Delete base.txt — Denied by you`,
  no duration.

Limit: the real TypeScript sidecar's denial path is proven by `cli/test/sidecar.test.ts` "D-12: ...", not by this capture
(which needs a model gateway for the real sidecar). The row above it, `× denied Delete base.txt`, is the approval's own record.
