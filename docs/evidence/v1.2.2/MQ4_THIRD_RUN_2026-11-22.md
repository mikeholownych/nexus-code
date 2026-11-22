# MQ-4 third local conformance run

## Result

- Execution: scheduled local user service, started 2026-11-22 03:00:30 UTC and completed 03:52:33 UTC (52m03s).
- Service result: `success`, exit status 0; stdout reported `engineering/deep 200/200, engineering/lead-reasoning 200/200`.
- Candidate: published v1.2.1 Linux x86_64 archive, source commit `b0d59908e75a51d57449e17bd348068713f2e567`, source tree `aac1a891b7a73753180922cf92fa971350eceadf`.
- Archive SHA-256: `18d2f2485d4c11e01d126447967f0967a1497484bcdeb6aaead299aefac5480a`.
- Capacity: the existing on-premises gateway; no paid provider or benchmark service was used.

| Gateway alias | Native valid | Repaired | Schema invalid | Invalid | Result |
|---|---:|---:|---:|---:|---|
| `engineering/deep` | 200/200 (100%) | 0 | 0 | 0 | Pass |
| `engineering/lead-reasoning` | 200/200 (100%) | 0 | 0 | 0 | Pass |

Each alias completed 50 attempts per tool (`read_file`, `write_file`, `edit_file`, `run_command`); all eight tool rows were 50/50 native valid. Each alias also passed all 5 hybrid-reasoning attempts per tool.

The untouched machine result is [`20261122T030030Z.json`](20261122T030030Z.json), SHA-256 `4862a47ed9c97921c2032b50190e2b0638aa08b448a51e39f707e9df46852f9b`. Its checked-in checksum matches. The scheduler copied the same bytes to its `last-good-result.json` after the successful run.

The prior two local runs failed: the first measured `engineering/deep` 200/200 and `engineering/lead-reasoning` 155/200; the second measured 198/200 and 155/200. All three results identify the same gateway limits versions and worker IDs, and use `toolChoice=auto`, temperature 0, and a 1.2 second request interval. The third result establishes a passing scheduled observation for this pinned archive and configuration; it does not explain the earlier invalid calls or establish repeatability or general model reliability. Continue scheduled monitoring and retain each result without rewriting past outcomes.
