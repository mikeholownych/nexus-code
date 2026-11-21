# MQ-4 second local conformance run

## Result

- Execution: operator-triggered local repeat, started 2026-11-21 14:04:39 UTC and completed 16:18:15 UTC (2h13m36s).
- Candidate: v1.2.1 archive, source commit `b0d59908e75a51d57449e17bd348068713f2e567`, source tree `aac1a891b7a73753180922cf92fa971350eceadf`.
- Archive SHA-256: `18d2f2485d4c11e01d126447967f0967a1497484bcdeb6aaead299aefac5480a`.
- Execution status: **non-conformant**. Both aliases were checked for 200 attempts across four tools with `toolChoice=auto`; no passing baseline was written.
- Capacity: the existing on-premises gateway, with cache bypass enabled; no paid provider or benchmark service was used.

| Gateway alias | Native valid | Repaired | Schema invalid | Invalid | Result |
|---|---:|---:|---:|---:|---|
| `engineering/deep` | 198/200 (99.0%) | 0 | 0 | 2 | Fail; below the 99.5% threshold |
| `engineering/lead-reasoning` | 155/200 (77.5%) | 0 | 0 | 45 | Fail; below the 99.5% threshold |

Per-tool results identify where failures occurred:

| Alias | `read_file` | `write_file` | `edit_file` | `run_command` |
|---|---:|---:|---:|---:|
| `engineering/deep` | 50/50 | 50/50 | 48/50 | 50/50 |
| `engineering/lead-reasoning` | 50/50 | 50/50 | 50/50 | 5/50 |

The run recorded a `not-conformant` alert payload at 16:18:15 UTC. This demonstrates alert recording for this run; it does not establish delivery to an operator.

The untouched machine result is [`20261121T140439Z.json`](20261121T140439Z.json), SHA-256 `39a2885217861c83999917cea79ab49810449aa86decc7b545b31b46508bd627`. The associated repeat alert payload is [`MQ4_CONFORMANCE_ALERT_REPEAT_2026-11-21.json`](MQ4_CONFORMANCE_ALERT_REPEAT_2026-11-21.json).

The first run measured `engineering/deep` at 200/200 and `engineering/lead-reasoning` at 155/200. The repeat shows the deep alias did not retain a perfect result and the lead-reasoning failure persisted. These observations are limited to the two gateway aliases, model versions and run configuration in the machine result; they do not establish general model reliability.
