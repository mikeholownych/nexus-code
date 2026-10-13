# Stage 8 pilot — T2, 2026-10-13 (appliance window 12:20–16:20 UTC)

**Verdict against the pre-registered thresholds (eval/README.md, committed ede562e before the scored runs):
NOT QUALIFIED — false VERIFIED = 2 (threshold 0).** The T2 pass-rate rule is met.

| Rule | Result | Met |
|---|---|---|
| false VERIFIED = 0 across all runs | 2 (both t2-feature-slugify) | **no** |
| Nexus pooled T2 pass rate ≥ best peer − 10 points | Nexus 90 % (27/30; 95 % CI 74–97) vs OpenCode 83 % (25/30; 66–93) | yes |
| no task where the best peer passes ≥ 4/5 and Nexus ≤ 1/5 | Nexus' lowest task 3/5 | yes |

Pooled (hidden tests): Nexus 27/30 · OpenCode 25/30 · Goose 24/30 · Aider 20/30. Per-task table in `SCORES.md`,
machine-readable `scores.json`, run manifests (harness ede562e + runner fixes, configuration, host) `manifest-*.json`.
Directional only: six fixture tasks, intervals overlap; qualification needs the full task set.

## Conditions

Nexus (feat/tui-surface @ 76f4081 build), Aider 0.86.2, OpenCode 1.18.35, Goose 1.27.2; all on `engineering/lead`
(Qwen3.6-35B-A3B Q4_K_M, llama.cpp b11347) via the appliance gateway, 64k context; fresh workspace and HOME per run;
60 steps / 20 min per task; the four agents ran concurrently on one worker. Deviations: see eval/README.md (fixtures,
T2 only, Codex excluded — no `/v1/responses`, Aider one `--message` exchange).

## Run validity

- 30 runs failed on infrastructure (the gateway refused connections ~12:33–12:52 UTC while four clients ran): Goose 20,
  OpenCode 10 — classified by each agent's own connection-failure message (`eval/infra.mjs`) and rerun; the reruns
  replace them in the scores, the originals are kept (`out/pilot-20261013/{goose,opencode}`). Nexus and Aider had none:
  both retry on connection failure (Goose and OpenCode do not) — a robustness difference, scored in T4, not here.
- Adapter faults found in smoke runs and fixed before scoring (inherited PWD, relative CA path); runs made before the
  CA fix are kept under `out/pilot-20261013/invalid/` and not scored.
- Contaminated runs (task sources changed or named): 0.

## Nexus findings

1. **False VERIFIED (2/5 on t2-feature-slugify).** The deliverable truncated `"The quick brown fox"` at maxLength 15 to
   `the-quick` (expected `the-quick-brown`, exactly 15 characters). The verifier was the discovered `npm test`, which
   ran Nexus' own new tests encoding the same misreading; the evidence rule (executed tests covering the changed
   file) was satisfied. VERIFIED today means "tests pass, including tests the agent wrote this turn" — those cannot
   catch a misread specification. Proposed (operator decision): VERIFIED only when the covering tests pre-date the
   turn or the verifier is operator-configured; otherwise a distinct, weaker outcome that says only self-written tests
   cover the change.
2. **No verifier for plain unittest layouts.** All 15 Python runs ended `UNVERIFIED / NO_APPLICABLE_VERIFIER`
   although the objective named `python3 -m unittest discover -s tests`; 14 of them were correct. Truthful, but it
   costs every Python VERIFIED. Verifier discovery should recognise `tests/test_*.py` with unittest.
3. One slugify run hit the 20-minute budget (`TIME_BUDGET_EXHAUSTED`, truthful); its deliverable passed the hidden
   test but its own added test failed (regression).
4. Cost: Nexus is the slowest per run (median 28–137 s vs Aider 25–72 s) and the only agent reporting tokens
   (median 34K–148K per task).

## Peer observations

Aider failed every t2-refactor-tax and t2-feature-slugify run (its own suite broken in 9/10); OpenCode and Goose passed
the refactor 5/5. t2-feature-slugify was the hardest task for every agent (Nexus 3/5, OpenCode 1/5, Aider 0/5, Goose
0/5).

## Rerun after fixes (Nexus ed17e99, 14:42–15:20 UTC)

Fixes: VERIFIED needs independent evidence — fail-before/pass-after on unmodified pre-change tests, or a configured
verifier (44786a4); unittest discovery (44786a4); prompt changes from a measured speed profile (ed17e99). Nexus and then
Goose ran **serially, alone on the gateway** (the pilot ran all four concurrently on a gateway that serves one request
at a time, which cost Nexus ~9.5 s per step). `SCORES_rerun_ed17e99.md`; manifests `manifest-rerun-nexus-ed17e99.json`,
`manifest-serial-goose.json`. No infrastructure failures, no contaminated runs.

**False VERIFIED: 0/30** (pilot: 2). Correct: 26/30 (87 %, CI 70–95; pilot 27/30). Outcomes:

| Task | Outcome (×5) | Correct |
|---|---|---|
| t2-bugfix-csv, t2-bugfix-duration | VERIFIED (failing test before, passing after) | 10/10 |
| t2-debug-logs, t2-feature-inventory | REGRESSION_FREE (existing tests passed before; new behaviour checked only by Nexus's tests) | 10/10 |
| t2-feature-slugify | REGRESSION_FREE | 2/5 — the 3 wrong answers are no longer claimed VERIFIED |
| t2-refactor-tax | REGRESSION_FREE | 4/5 |

Speed (median wall s; the pilot column was contended, so only the step and token changes are attributable to ed17e99):

| Task | Nexus pilot | Nexus ed17e99 alone | Goose alone | Nexus steps | Nexus tokens |
|---|---|---|---|---|---|
| csv | 34 | 25 | 21 | 6→6 | 46K→45K |
| duration | 28 | 17 | 15 | 5→5 | 34K→34K |
| debug-logs | 63 | 43 | 27 | 8→9 | 63K→73K |
| inventory | 53 | 29 | 30 | 9→6 | 73K→45K |
| slugify | 137 | 75 | 48 | 17→11 | 189K→107K |
| refactor-tax | 63 | 44 | 33 | 16→12 | 128K→98K |

Total for 30 runs alone: Nexus 22.1 min, Goose 14.9 min (Goose correct 24/30). Nexus is ~1.5× Goose's wall time,
from ~2× in the pilot; steps fell 30–35 % and tokens 25–43 % on the multi-step tasks. Remaining known costs: ~5.2K
tokens of tool schemas on every request (pruning not yet done), the pre-change verifier run the new VERIFIED rule
adds (one suite run per change), and more steps than Goose on debug-logs.

These six tasks were used to find and fix the issues, so this rerun confirms the fixes; it does not qualify Nexus.
Qualification needs a fresh task set.
