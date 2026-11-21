# MQ-4: first run from the installed timer (2026-11-21)

**Outcome: NOT CONFORMANT.** The result is recorded as the runner produced it.

## Candidate and execution

- Same candidate as the first live run: published v1.2.1, source commit `b0d59908e75a51d57449e17bd348068713f2e567`, archive SHA-256 `18d2f248…5480a` (verified by the job before it ran).
- Started by the `nexus-gateway-conformance.service` job at `2026-11-21T04:49:03Z`, result written `2026-11-21T05:37:19Z` (about 48 minutes; the gateway was otherwise quiet). Exit status 1; the alert went to the local alert log.
- Raw result: [`mq4-conformance-scheduled-run-2026-11-21.json`](mq4-conformance-scheduled-run-2026-11-21.json), SHA-256 `41e8a4d360e3f5b490dab9e36ae16c899d8daf8824bb34e87f59ed624d6797ba`.
- 200 attempts per alias (50 per tool), temperature 0, max output 8192, 1200 ms request interval, cache bypass on.

## Observed counts

| Alias | read_file | write_file | edit_file | run_command | Total native-valid | Feedback retries | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| `engineering/deep` | 50/50 | 50/50 | 50/50 | 50/50 | 200/200 (100%) | 45 | Pass |
| `engineering/lead-reasoning` | 50/50 | 50/50 | 5/50 | 50/50 | 155/200 (77.5%) | 5 | Fail |

## What this does and does not show

- `lead-reasoning` scored exactly what it did on 2026-11-18 (`edit_file` 5/50, 155/200) on the same archive, so that shortfall is **reproducible**, not a load artefact. The earlier run's caveat about a busy gateway does not apply to this alias.
- `deep` went from 177/200 (88.5%, run took 4 h 13 min under shared load) to 200/200 in 48 minutes on a quiet gateway. This is consistent with the earlier failures having been load-related, but two runs do not establish a cause. It used 45 feedback retries to get there, so it passes on the 99.5% native-valid bar with retries doing real work.
- `engineering/lead-reasoning` is served by `engineering/b0` (see WM-3-gateway-aliases.md), so this is also a statement about `b0` with that alias's limits.
- One run per alias; it says nothing about v1.2.2 or rc builds (rc.2 scored 200/200 on `lead-reasoning` on 2026-11-17, a different archive). The weekly timer will give a series.
- No baseline was written (`last-good-result.json` is only copied from a conformant run).
