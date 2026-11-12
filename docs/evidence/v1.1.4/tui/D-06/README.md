# D-06 captures

Driven with the audit harness (`docs/v1.1.4/tui-audit-harness/` on `origin/v1/v114-tui-audit`: `fake_openai.mjs`, `setup.sh trust`,
`t.sh`): fake OpenAI-compatible server on :18090, isolated HOME/state, tmux, `nexus --live --mode review`, prompt `SC:e429 go`
(the fake answers 429 with `retry-after: 2`), captured 14 s after sending, at 120x30 and 40x30, then `/details`.

- `before.txt`: `origin/v1/v114-int-3` (86687e2a). One identical line per attempt, two timers in the status bar.
- `after.txt`: this branch. One row that updates (`Retry N`, next attempt, bound, how to cancel), one timer, the raw error
  behind `/details`.

Host note: the PTY harness ran here (tmux 3.x); timings are wall-clock so the retry count (7 after 14 s) varies by run.
