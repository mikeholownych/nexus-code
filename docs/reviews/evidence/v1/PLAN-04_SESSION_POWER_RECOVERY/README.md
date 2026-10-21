# Recovery of unpublished session integration after power loss

Base: `8b98f8a70984a4ceffb5a82e5cdeccb630130ee6`. Working source hashes are retained alongside this report.

Surviving source under `/var/tmp/nexus-persistence-split-9zuqphkl/source` contained unpublished session integration previously described locally as commits 04f3f41/c7e4f9b. Its Git directory was under a vanished `/tmp` checkout; those commit identities are historical recovery leads, not available Git-object proof. Current remote source was compared directly against retained files before restoration.

Recovered behavior: serialize session/index/archive transactions through the canonical state-store guard, derive index metadata from protected committed state, count schema-two messages from committed cursors, and reject missing required schema-one conversation arrays instead of silently migrating to empty histories. Nine tests cover index counts/privacy/archive contention, SIGKILL after message sync and around envelope rename, migration retry preserving original/backup bytes, concurrent real-process updates, and missing legacy history quarantine.

Only the missing schema-one validation hunk was restored in state.ts. Newer journal IO-error handling and orphan companion cleanup remain intact. Current continuity and sidecar fixtures were not overwritten with historical versions.

## Validation

- Focused command: `node --import tsx --test test/{session_state_v2,task_state_v2,task_message_log,state,state_migration,file_guard,retention,retention_state_v2,persistence_protection,egress_persistence_equivalence,upgrade_transaction_recovery}.test.ts`: **140/140 pass**, zero failures/skips. See focused.txt.
- `tsc --noEmit`: exit 0, types.txt empty.
- Broader command also included durable_continuity.test.ts and sidecar.test.ts: **223 tests, 204 passed, 19 failed**, exit 1. See broader-failed.txt. Failures include absent workspace writes, different verification outcomes and crash-hook timeouts in those two files. These are unresolved validation failures; their cause has not been established by a baseline comparison. Local host lacks bwrap and a freshly built release core; CI normally provisions/builds these prerequisites. This observation does not excuse or close the failures.

All runs use isolated HOME/XDG and SSD-backed `/var/tmp`; no external inference or held-out payloads. Focused tests ran under the local SUITE claim. Exact-head equipped-host CI and independent review are required before integration. No RC, human acceptance, or release readiness is established here.
