# Node 22 focused regression run

- Snapshot: `/var/tmp/nexus-discovered-verifier-snapshot.PqKAFh`, corresponding to committed source `61f687896b5fd3682688ff477f9f3b54aecce28d`.
- Runtime: Node.js `v22.22.2`.
- HOME and XDG config/data/state/cache directories were isolated under `/var/tmp/nexus-node22-home.Pj2gX6`.
- Command: `node scripts/run_tests.mjs test/independent_verification.test.ts test/agent_discovered_verifier_premutation.test.ts`.
- Result: PASS, 35 tests, 0 failures, 0 skipped; duration 56,450.769 ms.
- Shared `SUITE` claim was held for the run and released after exit 0.
