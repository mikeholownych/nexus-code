# Qualification host preflight (synthetic infrastructure run)

- Host: `mike-dev`
- Time: `2026-10-20T03:38:06Z`
- Exact source: `db4aaf482f679e774ce5551d286f987102d15da4`
- Machine-readable result: `validate-20261020T0338Z-synthetic.json`
- Result SHA-256: `b9c47090577d05d327ad673e6f358de7e57b3c20276681c4d204436e74cbb51d`
- Frozen profile SHA-256: `4e8d42a218a68fa2fd3fd0de4d9788b205fa41b9ab71935cc2b6cf73f5d63543`
- Public manifest SHA-256 recorded by the validator: `50895b84a604fbfd45ed82e29cbef4ba795d7fffbe6611af23bfbc9851f3e89b`
- Outcome: 10/10 host checks passed.

The host applied the frozen CPU, memory, swap, process-count, and dedicated 20 GiB workspace controls. Bubblewrap 0.13.1 passed the minimum-version check. The evaluator ran under uid 985, was observed in its payload cgroup, and one session-escaped survivor was reaped; the report confirmed no residual evaluator process or run directory. Fail-closed qualification preflight cases passed.

The store argument was a temporary synthetic directory containing a canary file. The evaluator could not access that directory or the isolated operator home. No held-out store, task, answer, validator, or private corpus material was accessed. This run verifies the current host controls and denial of the synthetic path; it does not establish custodian-store permissions, corpus custody acceptance, or qualification readiness.

Complementary source-fixture evidence is exact integration CI run `39356488487` on the same commit. Its Node 20, 22, and 24 suites and Linux package job completed successfully. The current `cli/test/eval_integrity.test.ts` includes deliberate memory, process-count, workspace-write, CPU-throttle, timeout, and escaped-process cleanup fixtures; no qualification task was used to exercise them.
