# MQ-4 first live conformance run: v1.2.1

**Outcome: NOT CONFORMANT.** Both measured aliases fell below the configured 99.5% native-valid threshold. The recorded result was not edited to change the outcome.

## Candidate and execution

- Release: published Nexus Code v1.2.1.
- Source commit: `b0d59908e75a51d57449e17bd348068713f2e567`.
- Source tree: `aac1a891b7a73753180922cf92fa971350eceadf`.
- Archive SHA-256: `18d2f2485d4c11e01d126447967f0967a1497484bcdeb6aaead299aefac5480a`.
- Runner: installed v1.2.1 and `scripts/gateway_conformance.mjs` invoking the unchanged `eval/tool_grammar_matrix.mjs` fixture, 200 attempts per alias (50 per tool), temperature 0, max output 8192, 1200 ms request interval, cache bypass enabled.
- Gateway execution began at `2026-11-18T17:27:24Z` and ended at `2026-11-18T21:40:29Z`; exit status 1.
- Raw result: [`mq4-conformance-first-live-run.json`](mq4-conformance-first-live-run.json), SHA-256 `a8371251aaeabbbb53c6531cd9ae6aa547127dbab87d904c899f1dd23d06d9cb`.
- The GATEWAY claim was released at completion; the shared claim log records `2026-11-18T21:40:29.660Z` and `conformance not-conformant`.

## Observed counts

| Alias | `read_file` | `write_file` | `edit_file` | `run_command` | Total native-valid | Invalid | Feedback retries | Threshold result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `engineering/deep` | 49/50 | 44/50 | 43/50 | 41/50 | 177/200 (88.5%) | 23 | 36 | Fail |
| `engineering/lead-reasoning` | 50/50 | 50/50 | 5/50 | 50/50 | 155/200 (77.5%) | 45 | 5 | Fail |

Both aliases had zero repaired calls, zero schema-invalid calls, and zero throttled retries. The lead-reasoning failures were concentrated in `edit_file` (5/50 native-valid); the deep alias had failures across all four tools. The runner's top-level `passed` field is false for both aliases.

## Limitations and operating conditions

- This is one run, on one archive and one observation window. It does not establish a stable rate or explain the failures.
- The run took about 4 hours 13 minutes, compared with roughly 47 minutes for an earlier two-alias run. The operator observed other processes also connecting to the shared gateway during this run. Shared load and duration are caveats; there is no evidence here that they caused the low native-valid counts.
- The aliases were served by workers `b0-live-llama-deep-worker2` and `b0-live-llama-worker1`; their recorded server versions are in the raw JSON. Results apply only to this measurement.
- No timer or scheduled role was applied after the nonconformant result. A repeat run under a quieter, controlled gateway window is needed to assess repeatability before drawing broader conclusions.
