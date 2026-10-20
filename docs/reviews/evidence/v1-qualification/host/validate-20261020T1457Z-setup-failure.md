# Qualification host preflight (setup failure, preserved)

- Host: `mike-dev`
- Time: `2026-10-20T14:57:12Z`
- Exact source revision: `5ec51b45aa2300121ece635b504ad56b31b3bcbc`
- Machine-readable result SHA-256: `062c3b02adf05293813a788e164a92508ccfab6cbc8a863581ecf0a4c4fb1cd8`
- Outcome: **9/10 checks passed; fail-closed-preflight fixture did not run**.

The only failure was test setup: the command set `TMPDIR` to a path inside the isolated temporary home but did not create that directory. The fixture returned `ENOENT` while trying to create its temporary test directory. The evaluator account, resource controls, cgroup cleanup, process-tree reaping, synthetic-store denial, and workspace cleanup checks passed. No held-out data was used. This run is preserved, excluded from the successful result, and superseded by [the corrected 10/10 run](validate-20261020T1457Z-synthetic.md), which creates the temporary directory before execution.
