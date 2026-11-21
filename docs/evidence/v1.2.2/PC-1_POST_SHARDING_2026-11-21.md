# PC-1 PR CI after test sharding

Collected: 2026-11-21 14:50 UTC

**Result: the median PR CI time is 27:12, under the plan's 40-minute target** (baseline 42:19, `PC-1_BASELINE_2026-11-20.md`).

- Change measured: PR #669 (`perf(ci): shard cli suite within existing jobs`), merged 2026-11-21T10:42:20Z as `625d1e4c`. The CLI suite runs as two concurrent shards inside the existing jobs; no job was added or removed, and the required check names are unchanged.
- Source and method: the same as the baseline. GitHub Actions workflow `ci.yml`, `pull_request` events, completed and not cancelled; elapsed is `updatedAt - createdAt`, so it includes queue time.
- Sample: the first 20 such executions created after the merge (a fixed set, not the latest 20 at collection time). They are execution attempts, not 20 distinct pull requests.
- Results: 12 successes and 8 failures; median **27:12**; range **23:02 to 55:20**; 19 of 20 under 40:00.
- Reproduction: `gh run list --workflow ci.yml --event pull_request --limit 100 --json databaseId,createdAt,updatedAt,status,conclusion,headSha,displayTitle,attempt`; keep `status == completed`, `conclusion != cancelled`, `createdAt > 2026-11-21T10:42:20Z`; take the 20 earliest.

## What this does and does not show

- It shows the acceptance criterion as written: a median under 40 minutes over a 20-run sample after the optimization.
- One row is a re-run: its elapsed time spans a failed attempt plus the re-run of the failed job, which is why it is the maximum. Leaving out rows with more than one attempt, the remaining 19 have a median of 26:53 and a maximum of 30:08.
- Failed executions are included, as in the baseline. A run that fails early finishes sooner, so the 8 failures pull the median down somewhat; the successes alone have a median of 28:22.
- Several rows are repeated pushes to the same pull request; queue time varies with what else is running; the sample covers about four hours of one day. It is one sample, not a stable rate.
- The two shards run at the same time on one runner. One test failed intermittently during this window (`vc9_subagent_needs_input`, also intermittent on `main`; recorded in the claims log on 2026-11-21); whether sharding makes timing-sensitive tests fail more often was not measured.

| Run ID | Head SHA | Result | Elapsed | Attempt | Workflow |
|---:|---|---|---:|---:|---|
| 44913935606 | `860596ec` | failure | 23:02 | 1 | feat(cli,core): worker inside Docker; separate files-only worker with  |
| 44912989117 | `e0708ce8` | failure | 29:52 | 1 | feat(operations): admit parallel work by resource budget |
| 44911760610 | `3ef86e5a` | success | 25:26 | 1 | test(cli): cover Cargo VC-6 baseline attribution |
| 44910881887 | `8535c145` | failure | 23:13 | 1 | feat(operations): admit parallel work by resource budget |
| 44910701792 | `21ee249a` | failure | 26:07 | 1 | feat(cli,core): worker inside Docker; separate files-only worker with  |
| 44907918334 | `bcb75206` | failure | 24:36 | 1 | feat(cli,core): worker inside Docker; separate files-only worker with  |
| 44907899908 | `22c2debf` | success | 55:20 | 2 | feat(cli): blocked requirement and undecided steering conflict end BLO |
| 44905825724 | `5a5915db` | failure | 24:56 | 1 | feat(cli,core): worker inside Docker; separate files-only worker with  |
| 44905247844 | `2fae10a2` | success | 27:32 | 1 | feat(cli): blocked requirement and undecided steering conflict end BLO |
| 44903444645 | `9bc3fbf8` | failure | 26:34 | 1 | feat(cli,core): worker inside Docker; separate files-only worker with  |
| 44902958160 | `7f4a3c1e` | success | 29:10 | 1 | fix(delegation): enforce transient child authority |
| 44901033444 | `a4249461` | failure | 29:23 | 1 | fix(delegation): enforce transient child authority |
| 44900064193 | `382cede6` | success | 26:15 | 1 | test(lsp): expand real server lifecycle coverage |
| 44899670822 | `ade44dd4` | success | 26:53 | 1 | test(lsp): expand real server lifecycle coverage |
| 44899303954 | `92c9bf14` | success | 30:00 | 1 | test(lsp): expand real server lifecycle coverage |
| 44898782381 | `7b06685b` | success | 27:35 | 1 | test(lsp): expand real server lifecycle coverage |
| 44898455909 | `c611e90e` | success | 29:42 | 1 | test(lsp): expand real server lifecycle coverage |
| 44898162704 | `1fb54ea8` | success | 30:08 | 1 | test(lsp): expand real server lifecycle coverage |
| 44897860541 | `27ef95b9` | success | 29:58 | 1 | test(lsp): expand real server lifecycle coverage |
| 44897531308 | `0a06f1cd` | success | 26:49 | 1 | test(lsp): expand real server lifecycle coverage |
