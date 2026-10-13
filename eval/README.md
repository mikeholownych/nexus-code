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
- T2 hidden-test pass rate (pooled over all T2 runs of a configuration, point estimate, 95 % intervals reported) ≥ the
  best matched peer on the same local model **minus 10 percentage points**; and no task where that peer passes ≥ 4/5
  runs while Nexus passes ≤ 1/5. (Fixed 2026-10-13, before the first scored run. Rationale: at ~50 runs per
  configuration the 95 % interval half-width near 50 % is ~13 points, so a tighter margin is not distinguishable from
  noise and a looser one would accept a clear loss; the per-task guard stops a pooled rate hiding a task class Nexus
  cannot do.) The 6-task pilot is directional only; qualification needs the full task set;
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

## Pilot 2026-10-13 (4 h appliance window)

Configurations `configs/pilot-*.json`: Nexus, Aider 0.86.2, OpenCode 1.18.35, Goose 1.27.2, all on
`engineering/lead` (Qwen3.6-35B-A3B Q4_K_M, llama.cpp b11347) through the appliance gateway, 64k context. Six T2
fixture tasks (`t2-*`; each hidden test checked to fail on the fixture and pass on a reference fix kept outside the
repo). Budgets 60 steps / 20 min per task (Nexus steps; others by wall clock). The four agents run concurrently on the
same worker, so wall times include queueing.

Deviations from §9, recorded before the run: fixture tasks rather than external repositories at pinned commits; T2
only (no T3/T4 — the window is too short); Codex CLI excluded (the gateway does not serve `/v1/responses`); Aider runs
one `--message` exchange with `--yes-always` (its non-interactive mode); no cloud configuration (operator decision);
runs per task as many as the window allows, run-major, target 5.
