# INDEP-REVIEW-CONTINUITY — findings verification (static, follow-up to review-prep.md)

| | |
|---|---|
| Revision under review | `e1759ca` (worktree `/home/mike/nexus-wt/dec-amend`, HEAD `8cf3e82`). `git diff e1759ca..HEAD -- cli/src cli/test/durable_continuity.test.ts cli/test/compaction_continuity.test.ts` is empty except a comment-only change to `cli/src/tokens.ts`; `docs/v1.0.0/REQUIREMENTS.md` differs only in the REQ-AGT-118 and REQ-QUAL-105 rows (DEC-17/DEC-05 amendments) — the REQ-AGT-004 / REQ-AGT-102 rows quoted below are identical at both revisions. |
| Method | Read-only static verification. No tests, builds, or CLI runs (SUITE held elsewhere). All line numbers verified at this worktree. |
| Companion | `review-prep.md` (same directory) — findings F1–F9 referenced below by their prep IDs. |

---

## MEDIUM findings

### M1 (prep F1) — `durable` falls back to the depth heuristic when the option is omitted

- **Requirement / acceptance IDs:** REQ-AGT-102 (COMPACTION §C carried; "Durability is decided by an explicit property"), SPEC-04 finding AGT-02; touches ACC-CONT-03.
- **VERDICT: CONFIRMED (latent hazard; no incorrect live reliance today).**

**Code evidence.** `cli/src/agent.ts:1048`:

```ts
this.durable = durableOption !== undefined ? durableOption : depth === 0;
```

Durability is decided by an explicit property only when the caller passes one; omitted ⇒ the old implicit depth heuristic.

**Complete enumeration of `AutonomousAgent` construction sites in product source** (the durability decision point — compaction call sites themselves never pass `durable`; they inherit `this.durable`):

| Site | depth | `durable` passed? | Resolves to | Relies on fallback? |
|---|---|---|---|---|
| `cli/src/core/app.ts:86` `new AutonomousAgent(this.config)` | 0 (default) | no | `durable: true` | **YES** (top-level; correct behavior, implicit decision) |
| `cli/src/evaluator.ts:139` `new AutonomousAgent(config)` | 0 (default) | no | `durable: true` | **YES** (top-level; correct behavior, implicit decision) |
| `cli/src/agent.ts:3893-3898` subagent: `new AutonomousAgent(subagentConfig, this.depth + 1, inheritedWorktreeScope, { durable: false })` | parent+1 | **yes** (`false`) | `durable: false` | no |
| `cli/src/core/operation_runner.ts:566` work unit: `new AutonomousAgent(config, 1, undefined, { durable: true, role: unit.role, unitId: unit.id })` | 1 | **yes** (`true`) | `durable: true` | no (but see N1 below: line 567 re-asserts it post-construction) |

**Compaction invocation sites** (for completeness; all inherit `this.durable`, none pass durability): `commitCompaction` called from `agent.ts:3051` (auto/pressure trigger), `agent.ts:3500` (manual `compactNow`), `agent.ts:5165` (steering accept); `compactNow` called from `agent.ts:3443` (internal wrapper), `agent.ts:3538` (queue drain), `cli/src/sidecar.ts:380`, `cli/src/slash/session_commands.ts:133`, `cli/src/repl.ts:743`.

**Does any live path rely on the fallback today?** Yes, but only correctly: the two top-level sites (`app.ts:86`, `evaluator.ts:139`) omit the option and get `durable: true` from `depth === 0` — the desired behavior, decided implicitly. **No depth ≥ 1 product path relies on the fallback.** The hazard is exactly as prep stated: a future depth-1 site that omits `{ durable: ... }` silently gets a memory-only agent — the AGT-02 data-loss class. Note also (N3 below) that the SIGKILL crash-boundary evidence itself (`cli/test/helpers/compaction_crash_child.ts:26`) depends on the depth-0 fallback for its durability, and several test rigs construct depth-1 agents relying on the fallback for non-durability (`cli/test/team_convergence.test.ts:87`, `cli/test/context_convergence.test.ts:337,1210`).

**Minimal fix.** Either (a) fail loud: throw in the constructor when `depth > 0 && durableOption === undefined` (requires updating the crash-child helper and the depth-1 test rigs to pass `durable` explicitly — they should anyway), or (b) keep the fallback and pin it with the test below.

**Acceptance-evidence test (statically writable).** A source-scan test in the existing repo style (`cli/test/experimental_and_readonly.test.ts:47` reads source with `fs.readFileSync`):

```
test("AGT-02: every depth>=1 AutonomousAgent construction in cli/src passes `durable` explicitly", () => {
  // read every file under cli/src, regex for /new AutonomousAgent\(/ occurrences,
  // for each, capture the call's argument text; assert: either no depth argument is
  // passed (top-level, depth defaults 0), or the arguments include /durable\s*:/
  // Additionally assert agent.ts still contains the fallback only at the single
  // known site (or, post-fix, assert the fallback is gone).
});
```

plus a behavioral unit test: `new AutonomousAgent(cfg, 1, undefined, { durable: true }).durable === true`, `{ durable: false }` → false, and top-level default → true. **No live system needed — statically closable.**

---

### M2 (prep F2) — REQ-AGT-004 row contradicts REQ-AGT-102 row in REQUIREMENTS.md

- **Requirement / acceptance IDs:** REQ-AGT-004 vs REQ-AGT-102; ACC-CONT-03, ACC-CONT-10; ledger-truth per REQ-OPS-101/102 territory.
- **VERDICT: CONFIRMED (contradiction real; REQ-AGT-102 is the factually correct row for the work-unit mechanism).**

**Verbatim quotes** (identical at `e1759ca` and worktree HEAD):

`docs/v1.0.0/REQUIREMENTS.md:58` (REQ-AGT-004):

> | REQ-AGT-004 | COMPACTION §C | Durable compaction commit order archive → task → session (fsync). Failure stops the turn with PERSISTENCE_FAILED. Queued `/compact`. | `agent.ts:3070-3153` | TEST; HIST 1 live run | **tested (depth 0)** | **N (pending)** | **AGT-02a: not applied to work units** | ACC-CONT-03, ACC-CONT-10 | B (work units) / K (depth 0) | SPEC-04 |

`docs/v1.0.0/REQUIREMENTS.md:156` (REQ-AGT-102):

> | REQ-AGT-102 | COMPACTION §C (carried) | Durability is decided by an explicit property. Work units commit compactions durably. | data loss | `agent.ts` depth gates | SRC (AGT-02; test:cli/test/durable_continuity.test.ts) | **tested** | ACC-CONT-03 | **B** | AGT-02a | SPEC-04 / PLAN-04 |

**Which is factually right?** REQ-AGT-102. The durable-work-unit path exists and applies the compaction commit at depth > 0:

- Work-unit agents are constructed depth 1 **with** `durable: true` (`cli/src/core/operation_runner.ts:566`).
- `commitCompaction` branches on `this.durable` (`agent.ts:3339` `const durableUnit = this.durable;`), **not on depth**: archive written first (`agent.ts:3358-3367`), then task state + session under `withDurableSync` (`agent.ts:3387-3402`) — the full REQ-AGT-004 commit order runs for work units.
- The ACC-CONT-03 test exercises exactly this on a depth-1 work-unit agent and asserts `<task>.history.jsonl` contains the compaction id and `read_archive` returns originals after recovery (`cli/test/durable_continuity.test.ts:359-419`, construction at :374, assertions at :396-412).

So "AGT-02a: not applied to work units" is stale relative to PR-4b (`b890ea1`). What *remains* genuinely depth-0-limited in REQ-AGT-004's evidence: the SIGKILL crash-boundary tests run depth-0 agents (`cli/test/compaction_continuity.test.ts:533-573`; helper `cli/test/helpers/compaction_crash_child.ts:26`), and the ACC-CONT-10 live run is open. "tested (depth 0)" is therefore accurate **as a statement about the crash-boundary evidence**, but the "not applied to work units" note is wrong.

**Minimal ledger correction.** In `REQUIREMENTS.md:58`, replace the note "AGT-02a: not applied to work units" with e.g.:

> "AGT-02a applied to work units by PR-4b (`durable` property; `operation_runner.ts:566`; ACC-CONT-03 test `durable_continuity.test.ts:359`). Crash-boundary (SIGKILL) evidence remains depth-0 (`compaction_continuity.test.ts:533`) — see INDEP-REVIEW-CONTINUITY M3."

and resolve the **N (pending)** decision cell accordingly (the B-scope mechanism is implemented; what is pending is the M3 pressure/SIGKILL work-unit evidence and ACC-CONT-10). Mirror the same correction in `docs/v1.0.0/READINESS.md` (REQ-AGT-004 row: "tested at depth 0; B work-unit scope unresolved" — that row carries the same stale claim; prep missed this second ledger site). **Statically closable (docs edit).**

---

### M3 (prep F3) — ACC-CONT-03 evidence gap: no pressure-forced work-unit compaction, no work-unit SIGKILL

- **Requirement / acceptance IDs:** ACC-CONT-03 (SPEC-04), evidence cited for REQ-AGT-102/REQ-AGT-004; VQ-13.
- **VERDICT: CONFIRMED.**

**Acceptance wording, verbatim** (`docs/v1.0.0/specs/SPEC-04-continuity-and-durable-work.md:146`):

> | ACC-CONT-03 | Operation rig with a small `contextLimit` **forcing compaction**; **SIGKILL**; resume. `<task>.history.jsonl` contains the compaction id, and `read_archive` returns the originals. |

(PLAN-04 repeats it: `docs/v1.0.0/plans/PLAN-04-continuity-and-durable-work.md:54` — "operationRig with a small `contextLimit`, SIGKILL, then resume".)

**Code/test evidence.**

- The work-unit test sets `contextLimit: 6000` (`cli/test/durable_continuity.test.ts:368`) but the gateway script returns three small steps, so pressure **never** forces compaction; it is triggered explicitly: `const compactOutcome = await capturedAgent.compactNow(false);` (`durable_continuity.test.ts:391`). Confirmed.
- Resume in that test is **in-process** recovery (`new AutonomousAgent(...)` + `recoverFromTaskState(taskId)`, `durable_continuity.test.ts:401-404`) — no SIGKILL anywhere in it. Confirmed.
- The SIGKILL boundary tests (`cli/test/compaction_continuity.test.ts:533-573`) kill a real child at three commit points (`after_archive`, `mid_archive_line`, `after_task_state`, :536-541) — but the child is a **depth-0** top-level agent (`cli/test/helpers/compaction_crash_child.ts:26` — no depth argument, no durable option), and its compaction is also an operator compaction (`compactNow(false)`, crash_child.ts:51; header comment line 3: "runs an operator compaction and dies"). Confirmed: depth-0 only, and not pressure-forced either.

**Does the evidence cover the AC as written?** No. Element-by-element: (1) "small contextLimit **forcing** compaction" — not covered on a work unit (manual trigger); pressure-forced auto compaction is exercised only on a depth-0 agent with a mocked client, asserting admission state (`state=auto_compacted`) rather than durable records (`cli/test/context_auto_compaction.test.ts:73-129`). (2) "SIGKILL" — covered only at depth 0, with operator-invoked compaction. (3) "resume + history id + read_archive originals" — covered on the work unit (`durable_continuity.test.ts:396-412`) but without (1) and (2). Mitigation, as prep noted: all triggers funnel through the single `commitCompaction` (`agent.ts:3328`), so the commit machinery is shared; the gap is in the trigger/boundary path, not the commit logic.

**The missing test.** Extend the operationRig (`durable_continuity.test.ts:152-178`): small `contextLimit` with a gateway returning large tool outputs so the **auto** path (`agent.ts:3051`, `trigger: "auto"`) commits compaction mid-turn on the depth-1 `durable: true` work-unit agent; kill the agent process (crash-child pattern as in `compaction_continuity.test.ts:536-541`) at the commit boundary; resume via a fresh executor + `recoverFromTaskState`; assert `<task>.history.jsonl` contains the auto compaction id, `read_archive` returns the originals, and no action is replayed (cf. the no-replay assertion `compaction_continuity.test.ts:566`). This requires running the suite (SUITE claim) → **deferred to execution; the test specification itself is statically closable now.**

---

## LOW findings (re-verified)

### L1 (prep F6) — duplicate "latest" resume resolution — **CONFIRMED**

`cli/src/index.ts:356-367` and `cli/src/core/app.ts:178-187` implement bare-`--resume` independently: both do `listTasks({ workspace: targetWorkspace }).filter((t) => t.taskId !== <current taskId>)` and take `tasks[0]`, with an empty-list error ("no task to resume in …; see 'nexus status'") — but one path `exitAfterFlush(2)` (index.ts:362-365) while the other throws (`app.ts:184`). Divergence risk if sort/filter semantics change in one copy (REQ-AGT-101 / ACC-CONT-02). Minimal fix: extract one helper (e.g. `app.resolveLatestResumeTask()`) and have `index.ts` call it. Test: an existing-style CLI test asserting bare `--resume` with several tasks picks the same task through both entry points. Statically closable.

### L2 (prep F7) — non-durable agents push to `committedCompactions` memory-only — **CONFIRMED**

`agent.ts:3369-3372`: `this.messages = compacted; this.compactions++; …; this.committedCompactions.push(id);` run unconditionally, while the durable branch (`3358-3367`) wrote nothing for `durableUnit === false`; `agent.ts:3385` then returns "Compacted in memory (in-turn subagent)". "Committed" for subagents means "applied in memory". Safe today because subagents are never persisted (ACC-CONT-05 asserts exactly one task file, `durable_continuity.test.ts:535-576`), but the invariant lives only in convention — if a host ever persisted subagent messages, records would name compactions with no archive. Minimal fix: comment the invariant at the field/`commitCompaction`, or gate the push on `durableUnit`. Statically closable (comment) — behavioral guard test optional.

### L3 (prep F8) — `stepsUsed` reports ≥ 1 when none completed — **CONFIRMED**

`agent.ts:5530`: `stepsUsed: stepsUsed || Math.min(currentStep, maxTotalSteps)` — when `stepsUsed` is 0 (failure before any completed step) a plausible non-zero value is substituted. Cosmetic against ACC-CONT-06's "the true step count" (the AC's main substance — truthful UNHANDLED_ERROR, cancelled steering/compaction, failed checkpoint reported — is implemented at `agent.ts:5510-5572`). Minimal fix: `stepsUsed || 0`. Test: extend the existing unhandled-error test with a first-step throw asserting `stepsUsed === 0`. Statically closable.

### L4 (prep F9) — empty catch around cancel-drain — **CONFIRMED (harmless today)**

`agent.ts:5513-5515`: `try { await this.drainCompactionQueue(currentStep, undefined, "the turn failed unexpectedly"); } catch {}`. With a `cancelReason` set, `drainCompactionQueue` only calls `reportCompaction` per queued request (`agent.ts:3533-3535`), and `reportCompaction` guards each observer callback internally (`agent.ts:3548-3551`) — the throwing branch (`CompactionCommitError`, `agent.ts:3540-3542`) is unreachable when a cancelReason is passed. So nothing is swallowed today; the empty catch would silently hide future regressions in notice delivery. Minimal fix: replace `catch {}` with a logged/notice fallback. Statically closable.

### L5 (prep F5) — SPEC-04 AGT-13 attempt numbering unmapped — **CONFIRMED (unmapped)**

`docs/v1.0.0/specs/SPEC-04-continuity-and-durable-work.md:57`: "| AGT-13 | Attempt numbering repeats after 50. |" (listed in the Findings header, line 8). No requirement row, acceptance ID, or fix commit in the range; the only attempt-related code is the lost-record note at `cli/src/core/operation_runner.ts:615`. Disposition: record an explicit deferral or map to a requirement (REQ-OPS-101/102 ledger-truth territory); do not leave it silent. Statically closable (docs).

---

## NEW findings noticed during verification (max 3)

### N1 — LOW — post-construction `durable` override masks the explicit-property mechanism

`cli/src/core/operation_runner.ts:567`: `(agent as any).durable = true;` (with `role`/`unitId` re-asserted at :568-569) force-sets the `readonly` property **after** construction. If the constructor ever stopped honoring the `{ durable: true }` option at depth 1 (i.e., the exact AGT-02 regression REQ-AGT-102 exists to prevent), this line would paper over it — and no test asserts `agent.durable` by construction anywhere (grep: the only `durable` assertions are on compaction outcomes, `durable_continuity.test.ts:393`, and persistence results, `:696`). Acceptance evidence for the *mechanism* is therefore indirect. Fix: delete line 567 (the constructor already sets it) or add a construction-level assertion test. Related: the test rigs' `createAgent` callbacks ignore the executor-passed options object — `durable_continuity.test.ts:373` `(c) => …` and `:158` hardcode `{ durable: true }` rather than forwarding the `(c, depth, opts)` the executor supplies (`operation_runner.ts:564-565`) — so a regression in the executor's own option flow (dropping `durable: true` from :566) would also go uncaught. Fix: forward `opts` in the rigs, or add one test asserting the default (non-injected) executor path produces `agent.durable === true`.

### N2 — LOW — the SIGKILL crash-boundary evidence itself depends on the M1 fallback

`cli/test/helpers/compaction_crash_child.ts:26` constructs its agent with **no** durable option and relies on `depth === 0` → `durable: true` (`agent.ts:1048`). The durability of the entire crash-boundary evidence class (ACC-CONT-03/REQ-AGT-004's strongest evidence) is thus implicit, not an explicit property — and any fail-loud fix for M1 must update this helper or it breaks. Severity LOW (test-infra honesty); fold into the M1 fix.

### N3 — INFO — `durable` option-flow duplication in the two rig styles

The repo has two work-unit rig styles: `operationRig` (`durable_continuity.test.ts:152-178`) and inline executors (`:371-380`); both re-derive the agent independently of `operation_runner.ts:566`. This duplication is why the M3 gap (pressure/SIGKILL on a work unit) and N1's option-flow gap could both arise: no single test exercises the real `AgentWorkUnitExecutor` default construction path end-to-end with compaction. Consolidating on one rig that uses the executor's default `createAgent` (no injection) would close N1 and make the M3 extension natural. INFO severity — refactoring suggestion, not a defect.

---

## Disposition summary

| ID | Verdict | Requirement / AC | Closable statically? |
|---|---|---|---|
| M1 | confirmed (latent) | REQ-AGT-102 / AGT-02 | Yes — source-scan + construction tests |
| M2 | confirmed (REQ-AGT-102 is correct row) | REQ-AGT-004 vs REQ-AGT-102 | Yes — docs edit (+ READINESS.md) |
| M3 | confirmed | ACC-CONT-03 (SPEC-04:146) | Test spec now; execution deferred (SUITE) |
| L1 | confirmed | REQ-AGT-101 / ACC-CONT-02 | Yes |
| L2 | confirmed | REQ-AGT-102 (adjacent) | Yes (comment/guard) |
| L3 | confirmed | ACC-CONT-06 (cosmetic) | Yes |
| L4 | confirmed (harmless today) | ACC-CONT-06 (adjacent) | Yes |
| L5 | confirmed (unmapped) | SPEC-04 AGT-13 | Yes (docs) |
| N1 | new, LOW | REQ-AGT-102 evidence strength | Yes |
| N2 | new, LOW | M1/ACC-CONT-03 interaction | Yes (with M1 fix) |
| N3 | new, INFO | — | Yes (refactor suggestion) |

Live-system items remain as deferred in `review-prep.md` §5 (ACC-CONT-10 long task, bench recording, cross-process resume, capacity-retry, TUI queue, rename fault injection).
