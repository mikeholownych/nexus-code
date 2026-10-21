# Qualification host preflight (synthetic infrastructure run)

- Host: `mike-dev`
- Time: `2026-10-21T04:43:46.611Z`
- Tested repository revision: `d8c78fa2d710c86c29aa30ec4eff015101e2d95d`
- Exact integration parent: `833eec62b9f2da8e2e34e3d48a3b2d7d90715bf3`
- Evaluator source comparison: all `eval/` paths match the integration parent
- Machine-readable result: `validate-20261021T0443Z-synthetic.json`
- Result SHA-256: `f7f3f659206415165df97967246220a99f09f85c20ee9991df62236703be5362`
- Frozen profile SHA-256: `4e8d42a218a68fa2fd3fd0de4d9788b205fa41b9ab71935cc2b6cf73f5d63543`
- Public manifest SHA-256 used only as metadata: `50895b84a604fbfd45ed82e29cbef4ba795d7fffbe6611af23bfbc9851f3e89b`
- Outcome: 10/10 host checks passed.

The host applied CPU (`cpu.max = 800000 100000`), memory (16 GiB, swap disabled, group OOM), process-count (`pids.max = 4096`), and dedicated 20 GiB workspace controls. Bubblewrap 0.13.1 passed the patched-version check. The evaluator ran in the payload cgroup, the supervisor reaped a session-escaped process, and the validator found no residual evaluator process or run directory. Fail-closed preflight cases passed.

The store argument was a temporary root-owned synthetic directory containing one canary. The validator checked that the evaluator could not access its path; no held-out corpus, task, answer, validator, or private custody data was accessed. The synthetic store and temporary probe home were removed after the run.

This result verifies the host controls and the existing host preflight behavior at the tested revision. It does **not** demonstrate deliberate CPU, memory, process-count, or storage-limit violations under the separate evaluator UID, nor the full `eval/run.mjs` orchestration path with Git solution canaries. Those remain qualification-preflight evidence gaps; held-out qualification has not started.
