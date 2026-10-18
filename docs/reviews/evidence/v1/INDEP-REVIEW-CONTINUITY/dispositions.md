# Continuity/compaction review — finding dispositions (owner-directed, 2026-10-17)

Companion to `review-prep.md` (16 verification questions) and `findings-verification.md` (static verdicts at revision `e1759ca`). Each finding carries: requirement/acceptance IDs, disposition (implemented / boundary request / justified resolution), and the acceptance evidence that closes it. Revision under review: `e1759ca`; worktree HEAD at disposition time: `8cf3e82` (source-identical for `cli/src`, verified in findings-verification.md §header).

## M1 — `durable` option fallback masks missing explicit property (CONFIRMED, latent)

- **IDs:** REQ-AGT-102 (explicit durability property, AGT-02); ACC-CONT-03.
- **Evidence:** fallback at `agent.ts:1048`; live reliance at `cli/src/core/app.ts:86` and `cli/src/evaluator.ts:139`; explicit at subagent (`agent.ts:3893-3898`) and work unit (`operation_runner.ts:566`). No current depth ≥ 1 source site relies on the fallback.
- **Disposition: boundary request → continuity implementer (PLAN-04 owner; `cli/src/agent.ts`, `app.ts`, `evaluator.ts` are codex/PLAN-04 hot files).** Make `durable` explicit at both live call sites (or fail loud when omitted), add a source-scan regression test asserting every compaction entry site passes `durable` explicitly, and update the SIGKILL crash-child rig in the same change (N2: `helpers/compaction_crash_child.ts:26` currently depends on the fallback).
- **Acceptance evidence required:** new source-scan test green in a SUITE window; ledger row REQ-AGT-102 evidence cell cites it. Status: **OPEN** (claim-log boundary request 2026-10-17T19:0xZ).

## M2 — REQ-AGT-004 row contradicted REQ-AGT-102 row (CONFIRMED) — **IMPLEMENTED**

- **IDs:** REQ-AGT-004 vs REQ-AGT-102; ACC-CONT-03/10; ledger truth (REQ-OPS-101/102 territory).
- **Evidence:** rows quoted verbatim in findings-verification.md; `commitCompaction` branches on `this.durable` (`agent.ts:3339`), full archive→task→session order runs for work units (`agent.ts:3358-3402`); work unit passes `durable:true` (`operation_runner.ts:566`); ACC-CONT-03 test at `durable_continuity.test.ts:359`.
- **Disposition: implemented (docs-truth fix under owner-directed review mandate).** Ledger row REQ-AGT-004 note replaced: "AGT-02a applied to work units by PR-4b …; crash-boundary (SIGKILL) evidence remains depth-0 — see findings-verification.md M2". Decision cell resolved accordingly; status stays `tested (depth 0)` — accurate for the crash-boundary evidence, which is what remains depth-0-limited.
- **Acceptance evidence:** this correction is statically closable; the reviewer's file:line citations are the evidence. `check_requirements.mjs` re-run green. READINESS.md carries the same stale claim (line 33) — **added to the codex handoff** (`handoff-codex-t4-acceptance-2026-10-17.md`), consistent with the ACCEPTANCE/READINESS tracking file. Status: **CLOSED (ledger) / OPEN (READINESS mirror, codex-owned).**

## M3 — ACC-CONT-03 evidence gap: no pressure-forced work-unit compaction, no work-unit SIGKILL (CONFIRMED)

- **IDs:** ACC-CONT-03 (SPEC-04:146 verbatim requires small `contextLimit` **forcing** compaction + **SIGKILL** + resume); evidence cited for REQ-AGT-102/REQ-AGT-004; ACC-CONT-10 live run; VQ-13.
- **Evidence:** work-unit test uses manual `compactNow(false)` + in-process recovery (`durable_continuity.test.ts:391,401-404`); SIGKILL tests are depth-0 and operator-invoked (`compaction_continuity.test.ts:533-573`, `helpers/compaction_crash_child.ts:26,51`).
- **Disposition: boundary request → continuity implementer.** Add the specified test: operation rig with small `contextLimit` forcing compaction at a work-unit boundary, SIGKILL, resume, assert `<task>.history.jsonl` contains the compaction id and `read_archive` returns originals. Partially requires a live/long-running component; the offline rig portion is statically closable in a SUITE window.
- **Acceptance evidence required:** new test green; ledger REQ-AGT-004 decision cell flips to fully landed. Status: **OPEN.**

## L1 — duplicate "latest" resume resolution (CONFIRMED)

- **IDs:** REQ-AGT-101 (`run --resume` latest-task semantics); ACC-CONT-01/02.
- **Evidence:** `cli/src/index.ts:356-367` vs `cli/src/core/app.ts:178-187`, including exit-2-vs-throw divergence.
- **Disposition: justified resolution (recorded, low risk) + optional consolidation by the CLI-surface owner.** Behavior is consistent in the common path; divergence is in error surface. Consolidation belongs to the owning slice; not blocking. Status: **RESOLVED-AS-RECORDED (non-blocking).**

## L2 — non-durable agents push to memory-only `committedCompactions` (CONFIRMED, by design)

- **IDs:** REQ-AGT-102 (explicit `durable:false` path); AGT-02a.
- **Evidence:** `agent.ts:3369-3385`.
- **Disposition: justified resolution.** Non-durable agents deliberately keep memory-only tracking; the invariant "only durable agents rely on it for recovery" is held by construction and tests. If M1's fail-loud change lands, add one assertion that `durable:false` still tracks in memory. Status: **RESOLVED-AS-RECORDED.**

## L3 — `stepsUsed` reports ≥ 1 when no step completed (CONFIRMED, cosmetic)

- **IDs:** honesty adjacent (REQ-AGT-115/116 territory); no dedicated acceptance ID.
- **Evidence:** `agent.ts:5530`.
- **Disposition: justified resolution (cosmetic); fix opportunistically with any adjacent agent.ts change by the owning slice.** Not blocking; no separate ledger row warranted (avoids manufacturing requirements). Status: **RESOLVED-AS-RECORDED.**

## L4 — empty `catch {}` around cancel-drain (CONFIRMED, harmless today)

- **IDs:** none directly; robustness.
- **Evidence:** `agent.ts:5513-5515`; the only skipped path reaches the guarded `reportCompaction` (`agent.ts:3533-3551`).
- **Disposition: justified resolution.** Narrow the catch when `agent.ts` is next touched (log-at-debug), per owning slice. Status: **RESOLVED-AS-RECORDED.**

## L5 — SPEC-04 AGT-13 (attempt numbering repeats after 50) unmapped (CONFIRMED)

- **IDs:** SPEC-04:57; no requirement/acceptance row.
- **Evidence:** only `operation_runner.ts:615` touches attempts.
- **Disposition: boundary request → continuity implementer + spec owner.** Either map AGT-13 to a requirement with a fix, or record an accepted justification in SPEC-04. Per CONCURRENCY §4, discovered requirements go to the plan/PR "Needs from other slices", not silently into the ledger. Status: **OPEN (low).**

## N1 — `(agent as any).durable = true` post-construction override (NEW, LOW)

- **IDs:** REQ-AGT-102.
- **Evidence:** `operation_runner.ts:567`; rigs hardcode `{durable:true}` instead of forwarding executor opts (`durable_continuity.test.ts:158,373`).
- **Disposition: boundary request (bundle with M1).** Construct-forward the executor's durable opt; add a construction assertion. Status: **OPEN (bundled with M1).**

## N2 — SIGKILL crash-boundary evidence depends on the M1 fallback (NEW, LOW)

- **IDs:** ACC-CONT-03 evidence; REQ-AGT-004 depth-0 caveat.
- **Evidence:** `helpers/compaction_crash_child.ts:26`.
- **Disposition: boundary request (bundle with M1).** Update the rig in the same change as M1 or the crash tests break. Status: **OPEN (bundled with M1).**

## N3 — no test exercises the real default `AgentWorkUnitExecutor` construction path (NEW, INFO)

- **IDs:** REQ-AGT-102 acceptance strength.
- **Disposition: boundary request (bundle with M1/M3).** Consolidating the rigs closes N1 and enables M3's pressure-forced extension. Status: **OPEN (bundled).**

## Summary

| Disposition | Findings |
|---|---|
| Implemented | M2 (ledger correction; READINESS mirror → codex handoff) |
| Boundary request → continuity implementer (codex/PLAN-04) | M1, M3, L5, N1, N2, N3 (M1+N2+N3 bundled; M3 partially live-dependent) |
| Resolved-as-recorded (justified, non-blocking) | L1, L2, L3, L4 |

All boundary requests mirrored in the claim log and PR #11. Outstanding **live checks preserved** (not closed statically): ACC-CONT-10 live long task; ACC-CONT-08 bench p95; pressure-forced work-unit SIGKILL (M3's live portion); cross-process resume; fault injection at the task-state rename window.
