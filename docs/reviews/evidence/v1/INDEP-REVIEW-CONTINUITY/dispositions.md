# Continuity/compaction review — finding dispositions (owner-directed, 2026-10-17; updated 2026-10-18)

Companion to `review-prep.md` (16 verification questions) and `findings-verification.md` (static verdicts at revision `e1759ca`). Each finding carries: requirement/acceptance IDs, disposition (implemented / boundary request / justified resolution), and the acceptance evidence that closes it. Revision under initial review: `e1759ca`; closure implementation and independent runtime verification on `v1/plan-04-pr-4g-continuity` (PR #25, commit `79ed3ce` on base `a7126aa`).

## M1 — `durable` option fallback masks missing explicit property (CONFIRMED, latent) — **IMPLEMENTED & VERIFIED**

- **IDs:** REQ-AGT-102 (explicit durability property, AGT-02); ACC-CONT-03.
- **Evidence:** fallback at `agent.ts:1048`; prior reliance at `cli/src/core/app.ts:86` and `cli/src/evaluator.ts:139`; explicit at subagent (`agent.ts:4038`) and work unit (`operation_runner.ts:566`).
- **Disposition: implemented (`PLAN-04 PR-4g`, commit `79ed3ce`).** Made `{ durable: true }` explicit at `cli/src/core/app.ts:86`, `cli/src/evaluator.ts:139`, and `cli/test/helpers/compaction_crash_child.ts:87`, and added source-scan regression test `cli/test/durable_continuity.test.ts` (`"all source AutonomousAgent construction sites declare durability explicitly"`).
- **Acceptance evidence:** Independently reviewed and executed in a bounded `SUITE` window at `79ed3ce` (5/5 targeted tests pass, 0 failed). Status: **CLOSED.**

## M2 — REQ-AGT-004 row contradicted REQ-AGT-102 row (CONFIRMED) — **IMPLEMENTED & VERIFIED**

- **IDs:** REQ-AGT-004 vs REQ-AGT-102; ACC-CONT-03/10; ledger truth (REQ-OPS-101/102 territory).
- **Evidence:** rows quoted verbatim in findings-verification.md; `commitCompaction` branches on `this.durable` (`agent.ts:3339`), full archive→task→session order runs for work units (`agent.ts:3358-3402`); work unit passes `durable:true` (`operation_runner.ts:566`); ACC-CONT-03 test at `durable_continuity.test.ts`.
- **Disposition: implemented (docs-truth fix under owner-directed review mandate).** Ledger row REQ-AGT-004 note updated in PR #11 (`f771a3c`), and `READINESS.md` mirror updated in PR #9 (`a766c48`).
- **Acceptance evidence:** `check_requirements.mjs` green; `READINESS.md` reconciled. Status: **CLOSED.**

## M3 — ACC-CONT-03 evidence gap: no pressure-forced work-unit compaction, no work-unit SIGKILL (CONFIRMED) — **IMPLEMENTED & VERIFIED**

- **IDs:** ACC-CONT-03 (`SPEC-04:146` requires small `contextLimit` **forcing** compaction + **SIGKILL** + resume); evidence cited for REQ-AGT-102/REQ-AGT-004; ACC-CONT-10 live run; VQ-13.
- **Evidence:** prior work-unit test used manual `compactNow(false)` + in-process recovery; SIGKILL tests were depth-0 and operator-invoked.
- **Disposition: implemented (`PLAN-04 PR-4g`, commit `79ed3ce`).** Added `work_unit_pressure` mode in `cli/test/helpers/compaction_crash_child.ts` and `cli/test/durable_continuity.test.ts` (`"ACC-CONT-03: pressure compaction of a work unit survives SIGKILL and restores archived markers"`): runs a work unit through `AgentWorkUnitExecutor` / `driveOperation` with `contextLimit: 18_000` forcing automatic pressure compaction during the work-unit turn, kills the child with `SIGKILL` immediately after `<task>.history.jsonl` and task state are committed, and verifies in a fresh resumed work-unit agent (`recoverFromTaskState`) that `<task>.history.jsonl` contains the compaction id and `read_archive` returns the archived originals.
- **Acceptance evidence:** Independently reviewed (catching and fixing an initial marker-list scope bug between `fa2fee0` and `79ed3ce`) and verified in a bounded `SUITE` window at `79ed3ce` (`4,071 ms`, PASS). Live long-task `ACC-CONT-10` remains an M5 installed-RC gate. Status: **CLOSED (source/CI gate; ACC-CONT-10 live RC gate remains in M5).**

## L1 — duplicate "latest" resume resolution (CONFIRMED)

- **IDs:** REQ-AGT-101 (`run --resume` latest-task semantics); ACC-CONT-01/02.
- **Evidence:** `cli/src/index.ts:356-367` vs `cli/src/core/app.ts:178-187`, including exit-2-vs-throw divergence.
- **Disposition: justified resolution (recorded, low risk).** Behavior is consistent in the common path; divergence is in error surface. Status: **RESOLVED-AS-RECORDED (non-blocking).**

## L2 — non-durable agents push to memory-only `committedCompactions` (CONFIRMED, by design)

- **IDs:** REQ-AGT-102 (explicit `durable:false` path); AGT-02a.
- **Evidence:** `agent.ts:3369-3385`.
- **Disposition: justified resolution.** Non-durable agents deliberately keep memory-only tracking; the invariant "only durable agents rely on it for recovery" is held by construction and tests (`ACC-CONT-05`). Status: **RESOLVED-AS-RECORDED.**

## L3 — `stepsUsed` reports ≥ 1 when no step completed (CONFIRMED, cosmetic)

- **IDs:** honesty adjacent (REQ-AGT-115/116 territory); no dedicated acceptance ID.
- **Evidence:** `agent.ts:5530`.
- **Disposition: justified resolution (cosmetic).** Not blocking; no separate ledger row warranted. Status: **RESOLVED-AS-RECORDED.**

## L4 — empty `catch {}` around cancel-drain (CONFIRMED, harmless today)

- **IDs:** none directly; robustness.
- **Evidence:** `agent.ts:5513-5515`; the only skipped path reaches the guarded `reportCompaction` (`agent.ts:3533-3551`).
- **Disposition: justified resolution.** Status: **RESOLVED-AS-RECORDED.**

## L5 — SPEC-04 AGT-13 (attempt numbering repeats after 50) unmapped (CONFIRMED) — **IMPLEMENTED & VERIFIED**

- **IDs:** SPEC-04:57; PLAN-04 task 11.
- **Evidence:** `cli/src/core/objective.ts:408` `recordAttempt` (`n = lastN + 1` before slicing to `-50`); `cli/test/execution_tracking.test.ts:277` (`"AGT-13: recordAttempt counter is monotonic beyond 50 attempts"`).
- **Disposition: implemented (`PLAN-04 PR-4g`, commit `79ed3ce`).** Mapped `AGT-13` explicitly in `docs/v1.0.0/specs/SPEC-04-continuity-and-durable-work.md` (§1 and §3.2) to `objective.ts:408` and `execution_tracking.test.ts:277`.
- **Acceptance evidence:** Independently verified at `79ed3ce` (`AGT-13: recordAttempt counter is monotonic beyond 50 attempts`, PASS). Status: **CLOSED.**

## N1 — work-unit durability and identity defaults (NEW, LOW) — **IMPLEMENTED; custom-factory regression pending independent verification**

- **IDs:** REQ-AGT-102.
- **Evidence:** `cli/src/core/operation_runner.ts:559-567`; `cli/test/durable_continuity.test.ts`.
- **Disposition:** The production/default construction path supplies durable, role, and unit identity in the `AutonomousAgent` constructor. The default-path test was independently verified at `79ed3ce` (`2,117 ms`, PASS). A later compatibility change, `057ecb6`, retained a conditional post-construction fallback for injected custom factories that omit those options; the earlier review did not cover that later behavior. This fallback is now covered by `"AgentWorkUnitExecutor applies durable identity when a custom factory omits constructor options"` in the current correction slice.
- **Acceptance evidence:** The default-path evidence is independent and historical. The custom-factory regression passed on `104fba6e4172455f03a15f2b8fb378ac026088a5` (1 test, 0 failures), and an independent read-only review of that exact commit returned **ACCEPT**. The reviewer confirmed that the factory omits the executor's options, the executor applies the fallback, and the resulting operation persists the bound task state. The exact PR CI is still pending. This closes the source-level fallback evidence gap; it does not close installed-RC or release qualification gates.

## N2 — SIGKILL crash-boundary evidence depends on the M1 fallback (NEW, LOW) — **IMPLEMENTED & VERIFIED**

- **IDs:** ACC-CONT-03 evidence; REQ-AGT-004 depth-0 caveat.
- **Evidence:** `helpers/compaction_crash_child.ts`.
- **Disposition: implemented (`PLAN-04 PR-4g`, commit `79ed3ce`).** Updated `compaction_crash_child.ts` to pass `{ durable: true }` explicitly and added `work_unit_pressure` depth-1 work-unit crash mode. Status: **CLOSED.**

## N3 — no test exercises the real default `AgentWorkUnitExecutor` construction path (NEW, INFO) — **IMPLEMENTED & VERIFIED**

- **IDs:** REQ-AGT-102 acceptance strength.
- **Disposition: implemented (`PLAN-04 PR-4g`, commit `79ed3ce`).** Covered by `"AgentWorkUnitExecutor default construction persists a durable depth-1 implementer with its unit identity"` in `cli/test/durable_continuity.test.ts`. Status: **CLOSED.**

## Summary

| Disposition | Findings |
|---|---|
| Implemented & independently verified (`PLAN-04 PR-4g`, PR #25) | M1, M2, M3 (source/CI gate), L5, N2, N3 |
| Implemented & independently reviewed; exact PR CI pending | N1 |
| Resolved-as-recorded (justified, non-blocking) | L1, L2, L3, L4 |

Outstanding **live RC checks preserved** (M5 installed-RC gates, not closed by source tests): `ACC-CONT-10` live long task (≥60 steps, ≥2 compactions, kill/resume under independent reviewer §8); `ACC-CONT-08` persistence overhead p95 measurement.
