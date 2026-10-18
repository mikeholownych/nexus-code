# INDEP-REVIEW-CONTINUITY — review preparation and initial static pass

| | |
|---|---|
| Revision under review | `e1759cae9cf399e2d2586d05bfea3f86b757c412` (`e1759ca`), branch `v1/integration` |
| Base (main) | `db1ca55` |
| Worktree | `/home/mike/nexus-wt/dec-amend` (HEAD `9c13893` = `e1759ca` + one docs commit) |
| Worktree-read safety | `git diff e1759ca..HEAD --stat` verified: only docs, `cli/test/fixtures/token_calibration.json`, `cli/test/tokens.test.ts`, and a **comment-only** change to `cli/src/tokens.ts` (DEC-17 note). No continuity/compaction source differs. Worktree reads are valid for `e1759ca`. |
| Review constraints | Read-only except this file. No tests, builds, CLI runs, or long processes (SUITE claim held by another agent). Runtime items are DEFERRED. |
| Status | PREPARATION + initial STATIC pass. No verdict yet; REQ-AGT-110 / ACC-CONT-10 requires a live long task (≥ 60 steps, ≥ 2 compactions) — deferred. |

---

## 1. Change-set inventory (db1ca55..e1759ca)

The range contains the full v1.0.0 integration (~170 commits). Continuity/compaction-relevant commits:

### 1.1 PLAN-04 — continuity and durable work units (core of this review)

| Commit | Claim | Files (product + cited tests) |
|---|---|---|
| `2250de3` (+ merge `d90741e`) | PLAN-04 PR-4a: `run --resume <id>` resumes conversation/objective/id; bare `--resume` resolves latest task (REQ-AGT-101, ACC-CONT-01/02) | `cli/src/agent.ts`, `cli/src/core/app.ts`, `cli/src/core/state.ts`, `cli/src/index.ts`, `cli/test/durable_continuity.test.ts` |
| `eaaf847` | docs: mark REQ-AGT-101 tested via ACC-CONT-01/02 | `docs/v1.0.0/REQUIREMENTS.md` |
| `b890ea1` (+ merge `47c8c98`) | PR-4b: explicit `durable` property replaces depth gates; work units persist execution tracking + change baseline across resume (REQ-AGT-102, REQ-AGT-103, ACC-CONT-03/04) | `cli/src/agent.ts`, `cli/src/core/operation_runner.ts`, `cli/src/core/state.ts`, `cli/test/durable_continuity.test.ts`, REQUIREMENTS.md |
| `a3bd451` (+ merge `30950c7`) | PR-4c: unit ledgers, role tools (read_objective/update_requirements), non-empty prose check, 10k-transition options (REQ-AGT-107, ACC-CONT-07) | `cli/src/agent.ts`, `cli/src/core/objective.ts`, `cli/src/core/operation.ts`, `cli/src/core/operation_runner.ts`, `cli/src/core/roles.ts`, `cli/test/team_convergence.test.ts` |
| `a8db56a` (+ merge `a4cf93a`) | PR-4d: subagent hygiene, token accounting merge, `measureAdmission` in subagent loop, obligation-write fix (REQ-AGT-104, REQ-AGT-105, ACC-CONT-05; partial AGT-05 per REQ-AGT-111 POST-V1) | `cli/src/agent.ts`, `cli/test/durable_continuity.test.ts` |
| `029bc72` (+ merge `bdb2702`) | PR-4e: unhandled error path (truthful UNHANDLED_ERROR with real obligation) and durable-write failure reporting (REQ-AGT-106, ACC-CONT-06; AGT-14) | `cli/src/agent.ts`, `cli/src/core/app.ts`, `cli/src/core/turn.ts`, `cli/src/sidecar.ts`, `cli/test/durable_continuity.test.ts` |
| `92602d1` (+ merge `a090236`) | PR-4f: unknown-state stagnation rule, monotonic counter, persistence cost bench, docs (REQ-AGT-108, ACC-CONT-08/09) | `cli/src/core/execution_tracking.ts`, `cli/src/core/objective.ts`, `cli/src/operation_cli.ts`, `cli/src/slash/catalog.ts`, `cli/src/team.ts`, `cli/test/execution_tracking.test.ts`, `cli/test/perf/persistence_cost.bench.ts`, `docs/COMPACTION_AND_CONTINUITY.md` |

### 1.2 PLAN-08 — persistence/durability substrate (adjacent, in scope for "what survives")

| Commit | Claim |
|---|---|
| `29acb58` | PR-8a: honour `NEXUS_STATE_DIR` in default dirs; global test setup (`core/state.ts`, `session.ts`, `test/helpers/setup.ts`) |
| `9f5275a` | PR-8b: private state permissions (0600 dirs), doctor repair, startup banner; `core/durable_file.ts` grows the durable-sync primitives (`withDurableSync`) used by the compaction commit |
| `52feac8` | PR-8c: retention policy, `gc`, audit rotation, indexed session listing (`core/retention.ts`) |
| `d23dd4a` | PR-8d: corrupt state quarantine, future `schemaVersion` fail-closed, state compatibility (`core/state.ts`, `session.ts`, `state_migration.test.ts`) |
| `ea22ec2` | PR-8e: flight-log git exclude, parent-directory fsync (`core/file_ops.rs`, `git_exclude.ts`) |

### 1.3 Compaction-adjacent (PLAN-05 PR-5a — inference capacity path)

| Commit | Claim |
|---|---|
| `967b57a` | compact-and-retry on capacity rejection, cache context discovery, server-kind labels (REQ-PRV-101/102, ACC-INF-01/02) — `agent.ts`, `client.ts`, `core/provider_capabilities.ts`, `core/provider_recovery.ts` |
| `b148e78` | probe only the recognised local server's own context endpoint |

### 1.4 Related docs

- `docs/v1.0.0/REQUIREMENTS.md` — status flips embedded in the commits above.
- `docs/reviews/2026-10-13-compaction-continuity-acceptance.md` — **historical, pre-range** (self-assessment of the alpha.2 branch, base `a58f860`). It is provenance, not evidence for `e1759ca`.
- `docs/v1.0.0/specs/SPEC-04-continuity-and-durable-work.md`, `docs/v1.0.0/plans/PLAN-04-continuity-and-durable-work.md` — governing docs.

Note: the pre-existing depth-0 compaction machinery (commit protocol, queue, SIGKILL tests, `compaction_continuity.test.ts` 34 tests) shipped before `db1ca55` (alpha.2 work) and is *referenced* by this range, not introduced by it.

---

## 2. Requirements / acceptance mapping (from REQUIREMENTS.md + SPEC-04)

| REQ | Claimed status | Evidence cited | Acceptance | Static verdict so far |
|---|---|---|---|---|
| REQ-AGT-101 resume continues conversation/objective/id; bare `--resume` latest | tested | `durable_continuity.test.ts` (RT, AGT-01) | ACC-CONT-01, ACC-CONT-02 | Source matches (agent.ts:5846-5848, app.ts:176-192, index.ts:351-371); tests assert the real properties |
| REQ-AGT-102 durability by explicit property; work units commit compactions durably | tested | `durable_continuity.test.ts` (SRC, AGT-02) | ACC-CONT-03 | Property exists (agent.ts:1048); subagent `durable:false` (3897), work unit `durable:true` (operation_runner.ts:566); commit order archive→taskState→session (3339-3410). Residual: depth fallback default — see F1 |
| REQ-AGT-103 work units persist tracking + baseline across resume | tested | `durable_continuity.test.ts` | ACC-CONT-04 | recoverFromTaskState restores objective/tracking/baseline (agent.ts:1390-1406); tests check persisted repetition count = 2 then recovery note at 3 |
| REQ-AGT-104 accounting includes subagent + findings inference | tested | `durable_continuity.test.ts` | ACC-CONT-05 | stats merge in spawn path (agent.ts:3918-3919); test asserts `stats.requests >= gateway requests` |
| REQ-AGT-105 in-turn subagents write no durable records | tested | `durable_continuity.test.ts` | ACC-CONT-05 | Test asserts exactly 1 task file on disk (parent only) |
| REQ-AGT-106 escaping exception → truthful UNHANDLED_ERROR with real obligation | tested | `durable_continuity.test.ts` | ACC-CONT-06 | Catch block agent.ts:5510-5572; steering cancelled with notice; final checkpoint attempted, failures reported; `failedTurnFromError` demoted to pre-agent last resort (turn.ts:448) |
| REQ-AGT-107 implementer/tester cannot be COMPLETE with no change | tested | `team_convergence.test.ts` | ACC-CONT-07 | classify → BLOCKED no_change with 3 options (operation_runner.ts:684-688); 10k stop carries options (704, 734-745) |
| REQ-AGT-108 no false stagnation on unknown state identity | tested | `execution_tracking.test.ts` | ACC-CONT-09 | distinct successful mutation on unknown state counts as progress (execution_tracking.ts:414-421) |
| REQ-AGT-110 independent acceptance incl. one live long task (≥60 steps, ≥2 compactions) | **open** | this review | ACC-CONT-10, ACC-GOV-06 | Deferred — requires running system |
| REQ-AGT-001 no default step ceiling; labelled valves | tested | A §5, ACC-CONT-04/QUAL-T3 | — | continuation budget path seen at agent.ts:4767-4769; full walk not done this pass |
| REQ-AGT-004 durable compaction commit order; PERSISTENCE_FAILED; queued /compact | tested (depth 0) | agent.ts:3070-3153 | ACC-CONT-03, ACC-CONT-10 | Residual per REQUIREMENTS: **AGT-02a "not applied to work units"** marked `N (pending)` — see F2 below |
| REQ-OPS-001 persistence failure visible | tested | durable_continuity.test.ts | ACC-CONT-06 | reportPersistenceFailure single route (agent.ts:1896) |
| ACC-CONT-08 persistence cost bench | measurement | `cli/test/perf/persistence_cost.bench.ts` (148 lines, exists) | ACC-CONT-08 | Bench exists; **result recording not seen in docs** — verify recorded p95 vs 100 ms threshold (deferred/static-doc check) |
| SPEC-04 finding AGT-13 (attempt numbering repeats after 50) | **unmapped** | — | — | No requirement row, no fix commit found in range — see F5 |

**Discrepancy noted:** REQUIREMENTS.md REQ-AGT-004 row says "tested (depth 0)" with remaining-work note "**N (pending)** — AGT-02a: not applied to work units", while REQ-AGT-102 is marked "tested" and claims work-unit compaction durability via ACC-CONT-03. The `durable:true` work-unit path and ACC-CONT-03 test do exist, so the REQ-AGT-004 note appears stale relative to PR-4b — reconcile during the full review (documentation-truth issue, not necessarily a code issue).

---

## 3. Verification questions (16)

Durability & compaction

1. **VQ-1** Is durability decided by an explicit property or an implicit side effect (depth, call-site convention)? (REQ-AGT-102)
2. **VQ-2** Were *all* former `depth === 0` durability gates converted, and are the remaining depth checks genuinely about the interactive operator (steering/UI), not durability?
3. **VQ-3** Can compaction drop durable context needed to resume — do originals always reach the archive before any durable record names the compaction committed?
4. **VQ-4** What happens on crash between the archive write and the task-state write — are torn/uncommitted archive lines set aside and reported on recovery?
5. **VQ-5** What happens in the *same process* after a partial commit failure — is the turn actually stopped (PERSISTENCE_FAILED) and is the in-memory state never reported as durable?
6. **VQ-6** Is the low-yield/thrash hold unable to hide a real loop, and can compaction remove unseen tool results the model never observed?

Resume & continuity

7. **VQ-7** Does `run --resume` preserve objective, task id and conversation — including when the recovered task belongs to a different workspace or an incompatible schema?
8. **VQ-8** Does resume restore execution tracking and the change baseline so stagnation counting *continues* rather than resets? (REQ-AGT-103, ACC-CONT-04)
9. **VQ-9** Is the unverified-change obligation preserved across resume (no false NOT_REQUIRED / no laundring of unverified changes through a restart)?

Error paths & honesty

10. **VQ-10** On an escaping exception, are the reported obligation and step count true, and are queued steering and `/compact` cancelled with notices rather than silently dropped? (REQ-AGT-106, ACC-CONT-06)
11. **VQ-11** Are durable-write failures always reported and never reported as success — archive, task state, session, and the op start/end "crash recovery degraded" downgrade (SPEC-04 §5)?

Tests & evidence

12. **VQ-12** Do the cited tests assert the actual properties (request content, durable record contents, exit codes) or weak proxies (string includes, message counts)?
13. **VQ-13** Is any success path untested — specifically pressure-forced (not manually invoked) compaction on a *work unit*, SIGKILL at the commit boundary for a work unit, and the ACC-CONT-08 bench result recording?
14. **VQ-14** Do in-turn subagents write zero durable records, and does parent accounting include their inference? (ACC-CONT-05)

Work-unit semantics

15. **VQ-15** Can an implementer/tester unit become COMPLETE with no change; do BLOCKED decisions carry the typed options? (REQ-AGT-107, ACC-CONT-07)

Provider/retry interaction

16. **VQ-16** Does compact-and-retry on capacity rejection preserve continuity (no context loss or double-commit) across the retry boundary? (REQ-PRV-101/102)

---

## 4. Static findings (initial pass, at `e1759ca`)

### Verified correct (positive evidence)

- **P1.** Explicit `durable` property: `cli/src/agent.ts:1010,1048`; subagent `durable:false` at agent.ts:3893-3898; work unit `durable:true` at `cli/src/core/operation_runner.ts:566`. (VQ-1)
- **P2.** Commit order archive → task state → session with fsync under `withDurableSync`; archive failure leaves conversation uncompacted (throws before mutation); record failures throw `CompactionCommitError` with per-record detail: agent.ts:3358-3410, `cli/src/core/state.ts:331-339` (`appendLinesDurably`). (VQ-3)
- **P3.** Resume skips `resetConversation` (agent.ts:5846-5848); task id taken from recovered state (app.ts:174,188-191); bare `--resume` resolves latest and exits 2 with guidance when none (index.ts:351-371, app.ts:178-187). (VQ-7)
- **P4.** Recovery filters archive by committed ids, sets aside uncommitted/torn lines with a notice, restores objective/baseline/tracking, defaults obligation to pending, and never restores verification evidence: agent.ts:777-784,1374-1433 (`describeArchiveRead`, `unverifiedChangesPending ?? true`, `verificationEvidence = undefined`). (VQ-8, VQ-9)
- **P5.** Unhandled-error catch cancels queued compactions (via `drainCompactionQueue(..., cancelReason)` — the third parameter cancels, it does not run them: agent.ts:3530-3544) and queued steering, builds truthful UNHANDLED_ERROR from live state, attempts final checkpoint reporting failure: agent.ts:5510-5572. (VQ-10)
- **P6.** Unknown-state stagnation rule exactly per SPEC-04 §3.5: `execution_tracking.ts:404-431`; `priorRun` returns undefined on unknown (389-393); `repetitions` loop detection excludes unknown state (471). (VQ-15/ACC-CONT-09 side)
- **P7.** Tests are substantive, not weak: ACC-CONT-01 asserts codeword presence in the second request + taskId equality (durable_continuity.test.ts:282-309); ACC-CONT-03 asserts `<task>.history.jsonl` contains the compaction id and `read_archive` returns originals after recovery (359-419); ACC-CONT-05 asserts exactly one task file and stats ≥ gateway requests (535-576); real SIGKILL child at 3 commit-boundary points asserting record consistency and no replay (compaction_continuity.test.ts:533-573); persistence-failure truthfulness incl. ENOSPC/EACCES injection (433+). (VQ-12, VQ-14)

### Findings (issues / risks)

- **F1 — MEDIUM (latent).** The explicit durability property falls back to the old implicit heuristic: `this.durable = durableOption !== undefined ? durableOption : depth === 0` (`cli/src/agent.ts:1048`). Any future depth-1 construction site that omits `{ durable: true }` silently gets a memory-only agent — precisely the AGT-02 data-loss class the property was meant to kill. No such site exists today (grep: only operation_runner.ts:566 and the subagent path pass options). Consider a fail-loud default or a lint/test asserting every depth≥1 construction passes `durable` explicitly.
- **F2 — MEDIUM (doc truth).** REQUIREMENTS.md REQ-AGT-004 still says "tested (depth 0)" / "AGT-02a: not applied to work units / **N (pending)**", contradicting REQ-AGT-102 "tested" and the shipped `durable:true` work-unit path + ACC-CONT-03 test. One of the two rows is stale; reconcile before RC. (REQUIREMENTS.md:58 vs :156)
- **F3 — MEDIUM (evidence vs AC wording).** ACC-CONT-03's AC reads "small contextLimit forcing compaction; SIGKILL; resume". The cited test sets `contextLimit: 6000` but triggers compaction by explicitly calling `compactNow(false)` (durable_continuity.test.ts:391) — pressure-forced auto-compaction is never exercised on a work unit; and the SIGKILL boundary tests (compaction_continuity.test.ts:533) run only depth-0 agents. The shared `commitCompaction` path mitigates, but the AC as written is not fully covered. (VQ-13)
- **F4 — LOW (weak-ish assertion).** ACC-CONT-01's "contains the first turn's messages" is a substring check on `JSON.stringify(lastReq.messages)` for a codeword (durable_continuity.test.ts:299-301). It would pass if the codeword survived only in a condensed note. Consider asserting role/structure of the carried messages. (VQ-12)
- **F5 — LOW (unmapped finding).** SPEC-04 §1.3 lists AGT-13 ("attempt numbering repeats after 50") but no requirement row, acceptance ID, or fix commit exists in the range; grep finds no attempt-number handling beyond the lost-record note (operation_runner.ts:615). Either fix, map to a REQ, or record the deferral explicitly. (docs/v1.0.0/specs/SPEC-04:57)
- **F6 — LOW (duplicated "latest" resolution).** Bare-`--resume` latest resolution is implemented twice — `cli/src/index.ts:356-367` and `cli/src/core/app.ts:178-187` — both filtering out the current task id and taking `listTasks(...)[0]`. Divergence risk if sort/filter semantics change in one place.
- **F7 — LOW (naming/invariant hazard).** For non-durable agents, `commitCompaction` still increments `compactions` and pushes to `committedCompactions` (agent.ts:3369-3372) although nothing durable was written ("committed" then means "applied in memory" for subagents, per 3385). If a host ever persisted subagent messages, the record would name compactions with no archive. Currently safe (subagents are never persisted, and ACC-CONT-05 asserts it), but the invariant lives only in convention.
- **F8 — LOW (cosmetic truthfulness).** In the unhandled-error path, `stepsUsed: stepsUsed || Math.min(currentStep, maxTotalSteps)` (agent.ts:5530) substitutes a plausible number when 0, so a failure before any completed step reports ≥ 1 step used. Cosmetic; the AC only requires "the true step count".
- **F9 — LOW (masked errors).** `catch {}` around the cancel-drain in the catch path (agent.ts:5513-5515). With `cancelReason` set the only fallible call is `reportCompaction`, which is internally guarded — harmless today, but an empty catch here would silently swallow future regressions in notice delivery.

---

## 5. Items requiring a running system (DEFERRED — do not run in this session)

1. **D1 (ACC-CONT-10 / REQ-AGT-110, release-required):** live long task ≥ 60 steps with ≥ 2 compactions against the RC build; verify archive/records/resume end-to-end and record in `docs/reviews/`.
2. **D2 (ACC-CONT-08):** run `cli/test/perf/persistence_cost.bench.ts`; confirm the recorded p95 per-step persistence overhead vs the 100 ms SSD threshold, and that the measurement is recorded in docs (SPEC-04 §3.7 decides whether the split-record schema change triggers).
3. **D3:** live `run --resume` across a real process restart (not just in-process recovery): verify exit codes, banner/notice text (incl. the recoveryArchiveNotice wording), and that a bare `--resume` picks the intended task when several exist.
4. **D4:** live capacity-rejection → compact-and-retry (REQ-PRV-101/102): confirm the retried request is the compacted one and no double-commit of archive lines occurs.
5. **D5:** sidecar/TUI `/compact` queue during a real turn, including cancel and shutdown outcomes (acceptance doc notes no dedicated shutdown test and no live TUI queue run — carried here).
6. **D6:** fault injection at the task-state rename itself (POSIX-rename window) — acknowledged untested in the 2026-10-13 ledger; decide whether to fault-inject or formally accept rename atomicity.
7. **D7:** reconcile F2 against the actual REQUIREMENTS.md provenance (which commit last touched each row) and re-run the ACC-CONT-07/09 test files once the SUITE claim is free, to confirm the current suite agrees with the static reading.

## 6. Recommended review order for the next session

1. Confirm claims file availability; take/hold a review claim per CONCURRENCY.md; keep HOME isolation for anything executed.
2. Walk VQ-1/VQ-2 fully: enumerate every former `depth === 0` site listed in PLAN-04 task 2 and classify each remaining `depth` check at `e1759ca` (grep `this.depth` in agent.ts: 1484, 1639-1640, 2434, 3623, 3863 — verify each is genuinely operator-interactive, not durability).
3. Close F3: extend (or request extension of) ACC-CONT-03 to a pressure-forced work-unit compaction and a work-unit SIGKILL at the commit boundary; or record the deviation as accepted in the review report.
4. Reconcile F2 (REQ-AGT-004 vs REQ-AGT-102 rows) and F5 (AGT-13 ownership) as documentation-truth items (REQ-OPS-101/102 territory).
5. Full read of `commitCompaction` callers (auto path agent.ts:3051, manual 3500, steering-accept 5165, queue 3538) for boundary equivalence.
6. Run deferred items D1-D6 with the SUITE/GATEWAY claims properly held, then write the verdict against ACC-CONT-01..10.
