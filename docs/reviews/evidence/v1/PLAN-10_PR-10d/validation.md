# PLAN-10 PR-10d validation record

- Requirement: REQ-QUAL-103; acceptance: ACCEPTANCE §6.1.
- Implementation commits: `ef2d040` and `b27ae04` on `v1/plan-10-pr-10d`; evidence/ledger commit: `6726b8e`; based on `v1/integration@64c845730bc1d1544167e633c0a3568642b8260d`.
- Runtime: Ubuntu Linux x86-64, Node `v24.11.1`, npm `11.19.0`; `cli/package-lock.json` dependencies installed with `npm ci --prefix cli`.
- Launcher: `npm --prefix cli test -- test/eval_harness.test.ts`; test harness isolated HOME, started only local mock gateways, and used fake Goose/OpenCode executables to assert version capture, model/tool settings and budgets. No inference provider was contacted.
- Result: 9/9 `eval_harness.test.ts` tests passed. The targeted peer suite passed 6/6: the qualification runner refuses a wrong installed Nexus RC, nonzero sampling and a mismatched Nexus output allowance; versions and effective step/minute budgets are recorded; Goose/OpenCode receive configured settings; `score.mjs --pairs` rejects mismatched fingerprints/limits/budgets and accepts identical synthetic 5-run pairs.
- Additional validation: `opencode --pure debug agent nexus-eval` resolved `steps: 20` from the generated agent configuration (OpenCode `1.18.35`); Goose `run --help` exposes `--max-turns` (Goose `1.27.2`); Aider is not a required M5 peer. These are CLI/configuration checks, not live model qualification.
- `node --check eval/run.mjs` and `node --check eval/score.mjs` passed. The repository-wide `make test` was not run on this branch because the shared `SUITE` claim is held by `antigravity` on `v1/integration`.
- Artifact SHA-256: `eval/run.mjs` `482fc1b7d660921ab60d48203d22e8b8557ed5879de1ebfc8ee96b686620ac0a`; `eval/score.mjs` `12b19558e2fa60894a6dd02d379c2c0834c3e1448fc915cc56076e4239ab2264`; `cli/test/eval_harness.test.ts` `ee887eb87447b4259134353c30f4dafacccd370ade60c53c32d1f5adcaed1e70`; `eval/README.md` `8c3e04bea6bb722c34b63f421190e5f7ec6c2109c2af119482462cb854734e1`.
- Qualification boundary: no RC-installed 40-task run, provider-matched comparison, or release qualification is claimed. Thresholds and task counts were not changed.
