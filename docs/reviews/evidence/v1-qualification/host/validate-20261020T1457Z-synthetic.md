# Qualification host preflight (synthetic infrastructure run)

- Host: `mike-dev`
- Time: `2026-10-20T14:57:30Z`
- Exact source revision: `5ec51b45aa2300121ece635b504ad56b31b3bcbc` (descendant of integration `d7884f0b16a684bf40ed05bcb1421af14bd8cc93`)
- Machine-readable result: `validate-20261020T1457Z-synthetic.json`
- Result SHA-256: `c69cfc108b80247ae933068b63d3669fcd0dfaed2c1bb0b463b43be11a5da28e`
- Outcome: **10/10 host checks passed**.

The host applied the frozen CPU (`cpu.max = 800000 100000`), memory (16 GiB, swap disabled, group OOM), process-count (`pids.max = 4096`), and dedicated 20 GiB tmpfs workspace controls. Bubblewrap 0.13.1 passed the patched-version check. The evaluator ran in the payload cgroup; the supervisor reaped a session-escaped process, and no evaluator processes or run directories remained. The evaluator could not access the actual operator home or the temporary synthetic store. The run used isolated `HOME`; the validator selected the protected operator home from the account record.

The `--heldout` argument pointed only to a temporary root-owned directory containing a synthetic canary. The validator checked access by path and did not read its contents. No held-out corpus, task, answer, validator, or private custody material was accessed. This evidence does not establish custodian-store access controls, corpus acceptance, or qualification readiness.

An earlier attempt is preserved in [its report](validate-20261020T1457Z-setup-failure.json), and [summary](validate-20261020T1457Z-setup-failure.md). It failed one check because the isolated `TMPDIR` directory had not been created; the resulting `ENOENT` was in test setup. The corrected run above created that directory and passed all checks. The failed attempt was retained and not counted as a product failure or acceptance evidence.
