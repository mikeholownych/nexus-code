# MQ-4 first scheduled conformance run

## Result

- Execution: `nexus-gateway-conformance.service`, started 2026-11-21 04:48:49 UTC and finished 05:37:20 UTC.
- Candidate: v1.2.1 archive, source commit `b0d59908e75a51d57449e17bd348068713f2e567`, source tree `aac1a891b7a73753180922cf92fa971350eceadf`.
- Archive SHA-256: `18d2f2485d4c11e01d126447967f0967a1497484bcdeb6aaead299aefac5480a`.
- Execution status: non-conformant (service exit 1). The run covered 200 attempts per alias, with four tools and `toolChoice=auto`.

| Gateway alias | Native valid | Repaired | Schema invalid | Invalid | Result |
|---|---:|---:|---:|---:|---|
| `engineering/deep` | 200/200 (100%) | 0 | 0 | 0 | Pass |
| `engineering/lead-reasoning` | 155/200 (77.5%) | 0 | 0 | 45 | Fail; below the 99.5% threshold |

The untouched machine result is [`20261121T044849Z.json`](20261121T044849Z.json), SHA-256 `41e8a4d360e3f5b490dab9e36ae16c899d8daf8824bb34e87f59ed624d6797ba`. The alert payload is [`MQ4_CONFORMANCE_ALERT_2026-11-21.json`](MQ4_CONFORMANCE_ALERT_2026-11-21.json). No passing baseline was written.

## Alert-path observation

The conformance failure was detected, but the host-local alert script also failed to append the alert. The runner gives child commands a temporary `HOME`; the original host script built its log path from `$HOME`, so it targeted a directory that did not exist. The systemd journal recorded the underlying 155/200 failure and the alert command error.

After the run, the host-local `notify.sh` was changed to resolve its default log beside the script, with an optional `NEXUS_CONFORMANCE_ALERT_LOG` override. A manual JSON pipe with a temporary `HOME` verified that the message reaches the intended host log and not the temporary directory. This probe made no inference request. No inference rerun was performed, and this host-local script change is not part of the repository.

The timer remains local to the operator's on-premises gateway. This result uses no paid provider or benchmark service. Treat the failed alias as a conformance finding, not a passing result or evidence that all gateway aliases are safe.
