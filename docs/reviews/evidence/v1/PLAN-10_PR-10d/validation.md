# PLAN-10 PR-10d validation record

- Requirement: REQ-QUAL-103; acceptance: ACCEPTANCE §6.1.
- Implementation revision: `ef2d0409d5049373e8ec872326777ea6d5d25dea` on `v1/plan-10-pr-10d`, based on `v1/integration@64c845730bc1d1544167e633c0a3568642b8260d`.
- Runtime: Ubuntu Linux x86-64, Node `v24.11.1`, npm `11.19.0`; `cli/package-lock.json` dependencies installed with `npm ci --prefix cli`.
- Launcher: `npm --prefix cli test -- test/eval_harness.test.ts`; test harness isolated HOME, started only local mock gateways, and used fake Goose/OpenCode executables to assert version capture, model/tool settings and budgets. No inference provider was contacted.
- Result: 8/8 `eval_harness.test.ts` tests passed. The targeted peer suite passed 5/5: the qualification runner refuses a wrong installed Nexus RC; versions and effective step/minute budgets are recorded; Goose/OpenCode receive configured settings; `score.mjs --pairs` rejects mismatched fingerprints/budgets and accepts identical synthetic 5-run pairs.
- Additional validation: `opencode --pure debug agent nexus-eval` resolved `steps: 20` from the generated agent configuration (OpenCode `1.18.35`); Goose `run --help` exposes `--max-turns` (Goose `1.27.2`); Aider is not a required M5 peer. These are CLI/configuration checks, not live model qualification.
- Artifact SHA-256: `eval/run.mjs` `1d068f324137ac49a7a33b2b12cb6c56909bee8ff0efa7199950892dd63eff46`; `eval/score.mjs` `eb5049ced727ed4a7fc190c0707be0bac64c9a5ba76fa0a7a6959c9b6a9a25fe`; `cli/test/eval_harness.test.ts` `9a51b3441eb229403d5961c164dfc1e56075766d3f26e77810a796927e8a0f4f`; `eval/README.md` `8c3e04bea6bb722c34b63f421190e5f7ec6c2109c2af119482462cb854734e1`.
- Qualification boundary: no RC-installed 40-task run, provider-matched comparison, or release qualification is claimed. Thresholds and task counts were not changed.
