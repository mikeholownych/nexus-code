# D-04 captures

Audit harness (`docs/v1.1.4/tui-audit-harness/`), fake OpenAI-compatible server, isolated HOME/state, `nexus --live --mode review`,
tmux 120x40. `before/` is `origin/main` bef88219; `after/` is this branch. Each file is the pane after the turn, then `/git` and `/diff`.

| File | Scenario | Before | After |
|---|---|---|---|
| `write.txt` | write approved, then verifier `npm test` approved (it runs before the change) | `Done · not verified  Files changed, but no verifier ran` | `Files changed. npm test ran before the change; nothing checked the change itself.` |
| `deny.txt` | delete denied, fresh session | `Done  No files changed...` with header `●1 changed` (D-03) | `Done  No files changed: you denied 1 action.` |
| `cmd.txt` | read-only `run_command` (echo loop), verifier approved | `Done · not verified  Files changed...` | `Done  No files changed, so there was nothing to verify.` |
| `hello.txt` | no tools | header `●1 changed` (D-03) | header without a count |
| `carry-denied-after-write.txt` | write approved, then a delete denied in the next turn | `Files changed, but no verifier ran` | `No files changed this turn (1 action denied); changes from an earlier turn are still unverified.` |
