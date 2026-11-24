# Unattended schedules

A schedule is a standing order to start a [detached job](RUNNER.md) at a time. The runner (`nexus runner serve`) fires it: each run is a normal unattended job in a fresh worktree, with every rule of `nexus job start`. A schedule decides **when**; it cannot ask for more than a job can. Experimental, Linux only, like the runner.

```sh
nexus trust /path/to/repo                       # once, after you have read the repository
nexus schedule add --name nightly --cron '0 3 * * 1-5' --prompt "Run the test suite and report failures" -w /path/to/repo
nexus schedule list
nexus schedule status nightly
nexus schedule run-now nightly                  # one run now; the schedule's grid is not touched
nexus schedule pause nightly                    # and: resume, remove (alias rm)
```

`add`, `list`, `status` and `run-now` take `--json` (`add` prints `{schedule, upcoming}`, `status` prints `{schedule, latest_job, last_fired_job, pointer, receipt}`). `add` also takes the job options (`--verifier`, `--deliverable-file`, the budget flags, `-e/-m/--provider`), `--max-runs N`, and `--on-missed run-once|report`. There is no `--yes`, `--mode`, `--sandbox` or `--approve`: they are refused, as for `job start`.

## Triggers (all UTC)

| Option | Meaning |
|---|---|
| `--cron '<m> <h> <dom> <mon> <dow>'` | Five fields: numbers, `*`, ranges `a-b`, steps `*/n` and `a-b/n`, lists. No names (`MON`), no `@daily`, no seconds, no `a/n`. Day-of-week `0` and `7` are Sunday. When both day fields are restricted a day matches either (Vixie cron); when one is `*`, both must hold. |
| `--every 15m` | Seconds, or `s`, `m`, `h`, `d`: from 5 minutes to 30 days. Slots are `created + k * interval`, so the phase never drifts. The first run is one interval after creation. |
| `--at 2026-12-01T03:00:00Z` | One run, then the schedule ends. UTC with the `Z`; a date that does not exist is refused. |

There is no time zone and so no daylight-saving change: a cron hour is a UTC hour, a day has 24 hours, and the clocks changing locally moves nothing. Leap seconds do not exist (Unix time); `0 0 29 2 *` runs on 29 February only, and an expression with no match in the next four years (`0 0 30 2 *`) is refused at `add`.

## What a schedule may ask for

The job a run starts is built by the same code as `nexus job start` (`core/job_submission.ts`), from the schedule's own record, so a fresh worktree from `HEAD` at the time of the run, the operator's verifier and deliverables, the unattended approval policy, bounded budgets, a deadline and bounded crash resumes all apply. Specifically:

- **Permission level, fixed when you add it.** `read-only` unless you pass `--allow-worktree-write`, which allows writes inside the run's own worktree only. Nothing the job does changes it. Managed policy applies as for a job: if it requires a human for workspace writes, `add` refuses `--allow-worktree-write`.
- **No auto mode, no allow-always.** A run never approves a command or a network call: it is denied at once and the run ends `BLOCKED` with the question in its receipt (`nexus operation decide ... --no-resume`, then `nexus job resume`). A denial remembers nothing, so the next identical request is denied too. The record has no field for a mode or a grant, and the reader refuses one.
- **Trusted workspaces only.** `add` refuses a repository `nexus trust` has not listed (the list the operator owns; `NEXUS_TRUST_WORKSPACE` is not consulted), and the runner checks the list again at every slot: a repository whose trust was withdrawn is refused and reported.
- **Same workspace.** The record holds the real path of the repository. A path that later resolves elsewhere (a swapped link) is refused.
- **A verifier must be one the run can start.** An unattended run approves no command, the verifier included: a `--verifier` that the approval policy would ask about (for example `node --test`) is never run, completion is never accepted, and the run ends `BLOCKED`. Read-only commands such as `git status --short` run.

Not in v1.3.0: event triggers, SSH execution, wake checks, goal (objective-ledger) targets, time zones, schedule spec files (a repository cannot supply a schedule).

## Missed runs, overlap and the clock

A slot is **missed** when the runner could not serve it: it was not running, the host slept, or the clock jumped forward. A slot is on time when it is within 30 seconds of the runner looking at it.

- **Reported, never silent.** Every missed slot is counted. The runner writes one **gap** per catch-up: `count`, the `first` and `last` slot, the reason (`runner_not_running`, `overlap`, `refused`) in the schedule's record (the last 50 gaps), in `nexus schedule status` and `list`, in the runner log, and as a missed-run receipt `nexus-schedules/<id>.missed-<time>.json` (the last 20 are kept). A gap longer than 200 000 slots is reported as a lower bound (`truncated`).
- **Never replayed as a burst.** Late slots are never run one by one. With `--on-missed run-once` (the default) **one** catch-up job stands for the whole gap, for its last slot, and its receipt carries `missed: {count, first, last}` and `schedule_occurrence`. With `--on-missed report` no job runs for a gap. If the newest slot is on time, that job is the run; the gap rides in its receipt. Three days of an hourly schedule down is 72 missed slots, one job.
- **Phase kept.** The next slot is always the next one on the schedule's own grid after now.
- **Overlap.** A slot that falls due while the schedule's previous job is still running starts nothing: it is recorded as an `overlap` gap (`last outcome SKIPPED_OVERLAP`). Two jobs of one schedule never run at once; `run-now` refuses while one runs.
- **A refusal is a miss too.** A run that cannot be submitted (untrusted workspace, queue full at 32 jobs, a repository that is not a repository, managed policy) is recorded as a `refused` gap with the reason and the schedule moves on.
- **Clock stepped backwards.** If the runner finds the clock more than two minutes behind where it was, it counts the step (`status` shows it) and recomputes the next slot from the clock as it is, so the schedule does not sleep until the old time returns. A slot that already has a job (same schedule, same `dueAt`) is never started again, so going back and forward over a slot runs it once. A forward step is a gap of missed slots.
- **A runner that dies after submitting** does not run the slot twice either: the job found for the slot is the run.
- **Pause and resume.** Time spent paused is not missed time; `resume` continues from the next slot after now. A `once` whose time has passed cannot be resumed.
- `--max-runs N` ends the schedule after N started runs. At most 64 schedules; the 65th `add` is refused, and files beyond 64 are reported and never run.

## Delivery

Each run's receipt is the job receipt (`schedule_id`, `schedule_occurrence`, `missed`, `unattended: true`). The runner also records the outcome in the schedule (`last outcome`) and writes `<id>.latest.json`, a pointer `{jobId, receipt, outcome, integrationBranch, at}`. Results stay on the job's integration branch; nothing is merged and nothing is written into your checkout.

## Storage and what a schedule cannot protect against

Schedules live in `${NEXUS_STATE_DIR:-~/.nexus}/runner/nexus-schedules/` (0700, files 0600) under the lock `runner/nexus-schedules.guard`. Every file is read strictly (no link, owner and mode checked, bounded, no duplicate or unknown key); a record that fails is never run and is reported by `schedule list` and the runner log. The file schema is `docs/protocol/schedule-v1.schema.json`.

Nexus's own file tools refuse every path under `nexus-schedules` (read and write), so the agent a run starts cannot create, edit or delete a schedule.

What this does **not** stop: another program running as your user, including a shell command the agent runs in an attended session with full access (shell commands are advisory-checked only), can write a file here. Such a record is still bounded: it can only name one of the two job levels, the repository must be in your trust list at the moment of each run, it passes the same submission checks and the same unattended rules, and it needs a runner. It is not a boundary against your own account, as for the rest of `runner/`. Only the managed-policy tier is tamper-resistant. The host clock is trusted: a clock set wrongly is counted and reported, not corrected.
