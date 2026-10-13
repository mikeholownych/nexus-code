# Evaluation harness (qualification assessment §9)

`run.mjs` runs tasks against one agent configuration and appends a JSON line per run; `score.mjs` reports the scores
separately (never combined), per task and configuration, with 95 % Wilson intervals.

```bash
node eval/run.mjs --config eval/configs/gateway-engineering-deep.json --out eval/out/<label> [--only id,id] [--runs N]
node eval/score.mjs eval/out/<label>/results.jsonl          # markdown table; --json for machine output
```

Each run: a fresh workspace (the task's `fixture`, or its `repo.url` at `repo.commit`, cached in `eval/.cache`), a fresh
`HOME`, the agent with the task's budgets and a wall-clock timeout, then the task's **hidden** tests (copied in only
after the agent has stopped) and its `regression` command. `manifest.json` records the harness build (commit, dirty),
the configuration (secrets in `env` masked), host and Node version; per-run logs go to `logs/<task>-<run>/`.

## Task format (`eval/tasks/<id>/task.json`)

| Field | Meaning |
|---|---|
| `id`, `tier` | T1 smoke (scripted model, CI), T2 standard, T3 long-task, T4 fault-injected |
| `fixture` or `repo` | a directory in the task, or `{ "url", "commit" }` (external repositories at pinned commits) |
| `setup` | shell commands run in the workspace before the agent (e.g. `npm ci`) |
| `objective` | the operator text given to the agent |
| `steps`, `minutes` | budgets (defaults from the configuration: 300 steps, 120 min) |
| `hidden` | `{ dir, into, command, timeoutSec }` — tests the agent never sees; pass = artifact correct |
| `regression` | `{ command }` — the repository's own suite after the run |

## Scores

completion claimed · artifact correct (hidden tests) · false VERIFIED (VERIFIED while hidden tests fail) · regressions
introduced · timed out / harness errors · wall time, steps, tokens (median). Context qualifier (`contextNotRetained`) is
recorded per run.

## Pre-registered thresholds (from the assessment, fixed before any live run)

- false VERIFIED = 0 across all runs;
- T2 hidden-test pass rate ≥ best matched peer on the same local model minus a margin — **margin not yet fixed**
  (to be recorded here before the first live run), or an absolute target if no peer can be matched;
- T3: false-absence claims = 0 and steering constraints honoured in ≥ 95 % of runs;
- T4: truthful bounded outcome in 100 % of fault runs;
- ≥ 5 runs per task-configuration, per-task results with 95 % intervals.

## Status

| Part | State |
|---|---|
| Runner, scorer, manifest, per-run logs | done |
| T1 self-test (`selftest-add`, scripted model, in `make test` via `cli/test/eval_harness.test.ts`) | done |
| Nexus adapter | done |
| Peer adapters (OpenCode, Goose, Aider, Codex) | not started |
| T2/T3 task set (pilot 12, external repos, hidden tests) | not started |
| T3 fact-sheet scorer (absence claims) and steering checks | not started |
| T4 fault injector | not started |
| Live runs | blocked on inference hours, cloud budget and peer installs (operator decision) |
