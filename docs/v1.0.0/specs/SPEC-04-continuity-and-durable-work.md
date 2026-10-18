# SPEC-04: Task continuity, resume and durable work units

| | |
|---|---|
| Status | Ready. Team and operation commands ship as experimental, with the AGT-02a fix still a blocker, per [DEC-03](../DECISIONS.md#dec-03-team-and-operation-scope-in-v1). |
| Release class | **BLOCKER**: `run --resume` (AGT-01), work-unit compaction durability (AGT-02a; a blocker even though team and operation are experimental, per DEC-03). RELEASE-REQUIRED: the rest. |
| Requirements | REQ-AGT-101, REQ-AGT-102, REQ-AGT-103, REQ-AGT-104, REQ-AGT-105, REQ-AGT-106, REQ-AGT-107, REQ-AGT-108, REQ-AGT-110 |
| Findings | AGT-01, AGT-02, AGT-03, AGT-04, AGT-05, AGT-06, AGT-08, AGT-09, AGT-11, AGT-12, AGT-13, AGT-14, AGT-15, HIST-09 |
| Plan | [PLAN-04](../plans/PLAN-04-continuity-and-durable-work.md) |
| Acceptance | ACC-CONT-01 to ACC-CONT-09 |

## 1. Problem

The depth-0 interactive path is the TUI/REPL turn. That path's continuity design has the following properties:

- no default step ceiling;
- state-aware stagnation detection;
- a durable archive → task → session compaction commit;
- queued `/compact`;
- truncation recovery.

All of these are implemented and pass scripted tests (A §5; baseline 905/905). This spec covers the paths around that core that do not honour the same contract.

### 1.1 AGT-01: `nexus run --resume <id>` does not resume

Reproduced (A §4 R2). The failure has three parts:

- `ApplicationCore.runTask` recovers task state (`cli/src/core/app.ts:174-177`). `agent.run()` then calls `resetConversation()` unconditionally (`cli/src/agent.ts:5236`). The resumed request carried two messages, the system prompt and the new prompt, and the objective was cleared.
- The result is keyed by a new task id. `taskId` is captured before recovery (`app.ts:174`).
- `--resume` with no id passes the literal `"latest"` (`cli/src/index.ts:176`), which fails with "Task state not found".

The only existing test asserts that the unverified-change flag survives (`cli/test/durable_continuity.test.ts:254`).

### 1.2 AGT-02: work units are classed by depth, not durability

Work units (`/team`, `nexus operation`) run as `new AutonomousAgent(config, 1)` and *are* durable: they are resumed from task state (`operation_runner.ts:559`). But every durability rule is gated on `this.depth === 0` (`agent.ts:3081,3127,1136-1139,4389,1489-1501,4034`). The consequences:

- a. Compaction happens in memory only, with no archive. The next `persistProgress` writes the compacted conversation and a `committedCompactions` id that has no archive lines. The originals are lost, and `read_archive` cannot return them after resume. This contradicts `docs/COMPACTION_AND_CONTINUITY.md:145-160`.
- b. Work units have no objective ledger or requirement gating.
- c. `ExecutionTracker.fresh()` runs every turn, so loop and stagnation history resets on every resume.
- d. There is no change baseline, so a discovered-verifier pass can never be VERIFIED.

`runningAsSubagent` (`agent.ts:5003`) already distinguishes the two cases.

### 1.3 Other gaps

| ID | Gap |
|---|---|
| AGT-03 | Subagent and findings-distillation inference is not counted in token/request stats. Reproduced: 4 gateway requests, stats showed 2. |
| AGT-04 | In-turn subagents write orphan durable task records (reproduced). |
| AGT-05 | The duplicated subagent loop (`agent.ts:5298-5431`) skips admission measurement, strict counting, empty-reply retry and steering. The offered and accepted tool sets differ. |
| AGT-06 | The subagent obligation write short-circuits `setUnverifiedChanges`. |
| AGT-08 | An exception escaping `runTurn` yields `failedTurnFromError` with a hard-coded `unverifiedChangesPending:false` and `steps.used:0` (`turn.ts:444-460`, `app.ts:229`). Queued steering and compaction are never reported. |
| AGT-09 | Once state identity is "unknown" (more than 1.5 s on a large repo, `agent.ts:2026-2047`), ≥12 consecutive successful writes count as no progress, which gives a false STAGNATION_DETECTED (INFERENCE). |
| AGT-11 | Implementer/tester units become COMPLETE with NOT_REQUIRED, which means no change was made (`operation_runner.ts:651-663`). |
| AGT-12 | The 10,000-transition safety bound leaves a decision with `options: []`. |
| AGT-13 | Attempt numbering repeats after 50; resolved by the monotonic `recordAttempt` counter (see §3.2). |
| AGT-14 | Durable-write failures for op start/end, plan and recovery checkpoints are swallowed. |
| AGT-15 | Every tool call rewrites the whole task JSON three times or more, with redaction and fsync (unmeasured). |

| HIST-09 | The compaction/continuity and truncation-recovery changes shipped in alpha.2 with "independent acceptance pending". |

**AGT-13 resolution.** Verification attempt numbering is monotonic: `cli/src/core/objective.ts` `recordAttempt` assigns `n = lastN + 1` before retaining only the latest 50 entries. This is covered by `cli/test/execution_tracking.test.ts` (“AGT-13: recordAttempt counter is monotonic beyond 50 attempts”).

## 2. Requirements

1. **REQ-AGT-101.** `nexus run --resume <id>` continues the recovered conversation, objective and task id. `--resume` with no id resolves the most recent task for the current workspace, or is rejected at parse time with the list command to run.
2. **REQ-AGT-102.** Durability is decided by an explicit `durable: boolean` agent property, not by depth. Every durable agent (the depth-0 turn and work units) commits compaction through archive → switch → records, and stops with PERSISTENCE_FAILED when compaction cannot be committed. Only in-turn subagents are memory-only.
3. **REQ-AGT-103.** Durable work units persist execution tracking (loops, stagnation, cumulative steps) and their change baseline across resume.
4. **REQ-AGT-104.** Token and request accounting includes subagent and findings inference.
5. **REQ-AGT-105.** In-turn subagents write no durable task records.
6. **REQ-AGT-106.** Any exception escaping the loop produces an agent-built `FAILED / UNHANDLED_ERROR` result. That result carries the true pending-change obligation and step count, a final checkpoint, and cancellation notices for queued steering and `/compact`.
7. **REQ-AGT-107.** Units with an implementation or verification role cannot become COMPLETE with NOT_REQUIRED. Instead they are BLOCKED with a typed decision: retry, accept as no-op, or stop.
8. **REQ-AGT-108.** Successful mutations with distinct arguments count as progress when state identity is unknown. Stagnation still triggers on repeated identical actions.
9. **REQ-AGT-110.** Independent acceptance of the compaction/continuity and truncation-recovery behaviour, recorded in `docs/reviews/`. This is an acceptance item, not code.
10. **REQ-AGT-111 (POST-V1).** The main loop and the subagent loop share one step implementation (AGT-05). For v1, AGT-05's divergences are documented, and the strict-counting gap is closed by calling `measureAdmission` in the subagent loop.

## 3. Proposed design

### 3.1 Resume (`core/app.ts`, `agent.ts`, `index.ts`)

- Change `AutonomousAgent.run(prompt, { resume?: boolean })`. When `resume` is true, skip `resetConversation()` and keep `this.objective`. The new prompt is appended as an operator follow-up, which goes through the existing "continue"-style objective rules (`objective.ts`).
- In `ApplicationCore.runTask`, take `taskId` from `recoverFromTaskState` when resuming.
- In `index.ts:176`, resolve `--resume` with no id to `listTasks({ workspace }).sort(updatedAt desc)[0]`. If there is none, exit with code 2 and the message `no task to resume in <ws>; see 'nexus status'`.
- Add an `exit code` row for "resume target not found" in USER_MANUAL Outcomes.

### 3.2 Durability property

- Constructor: `new AutonomousAgent(config, depth, { durable })`.
  - `AgentWorkUnitExecutor` passes `durable: true`.
  - `runSubagent` passes `durable: false`.
  - Depth 0 defaults to `durable: true`.
- Replace each `depth === 0` gate in the list above with `this.durable`, except gates that really are about the interactive operator: steering and the onConfirm UI. Classify each of the roughly 12 call sites in the plan (PLAN-04 task 2), with a one-line rationale per site.
- Work units get an objective ledger keyed by the unit id. `update_requirements` and `read_objective` are offered to units with role ∈ {implementer, tester}.
- **AGT-13 resolved:** `cli/src/core/objective.ts` `recordAttempt` assigns `n = lastN + 1` before slicing the retained attempts to 50. Regression coverage is `cli/test/execution_tracking.test.ts`: “AGT-13: recordAttempt counter is monotonic beyond 50 attempts”.

### 3.3 Accounting and records

- `runSubagent` returns `{ report, tokenStats }`. The parent merges the stats. `recordFindings` increments `requests`.
- `initTaskState` in the constructor is skipped when `!durable`.

### 3.4 Unhandled error path

Wrap the body of `runTurn` (`agent.ts:4254-4995`) in `try/catch`. On an unexpected error:

1. Build `buildTurnResult({ status: FAILED, reason: UNHANDLED_ERROR, error: redact(err) })` from the live state.
2. Attempt a final checkpoint. Failure here is reported, not thrown.
3. Cancel the queued steering and compaction with notices.
4. Rethrow nothing.

`failedTurnFromError` remains only as the last resort for errors before the agent exists.

### 3.5 Stagnation when state is unknown

In `execution_tracking.ts evaluateStep`, if `stateIdentity === "unknown"` and the step had a successful `write_workspace` call whose canonical args differ from every call in the window, the step counts as progress. Add the inverse test: identical writes repeated 13 times still stagnate.

### 3.6 Team outcome semantics

In `operation_runner.ts classify`, `turnSucceeded && outcome === NOT_REQUIRED && role ∈ {implementer, tester}` gives `BLOCKED(decision: no_change)` with options `["retry", "accept_no_change", "stop"]`. Also give the 10,000-transition stop the options `["resume", "stop"]` (AGT-12).

### 3.7 Persistence cost (AGT-15)

First measure (ACC-CONT-08). If p95 step overhead is ≥ 100 ms on SSD at 200 steps, split the task record into a small `progress` file rewritten per event and an append-only `messages.jsonl`. That is a schema change: bump `schemaVersion` to 2 with a migration, per SPEC-08's corruption/migration rules. Otherwise defer to post-v1.

## 4. State changes and migration

- No schema change is needed for §3.1–3.6. Work units gain archive lines and a ledger.
- Existing durable unit records written by alpha.2 may name compactions without archive lines. On load, `recoverFromTaskState` already filters uncommitted archive entries and reports torn lines. Add a notice: "this unit was compacted by an earlier version; originals before <id> are not recoverable".

## 5. Failure handling

All durable-write failures go through one `reportPersistenceFailure(kind, err)` (AGT-14):

- an operation start/end failure is a warning, plus a durable-flag downgrade to "crash recovery degraded";
- a compaction commit failure stops the turn, as today.

## 6. Alternatives

| Alternative | Why not chosen |
|---|---|
| Remove `nexus run --resume` | It is a documented workflow (USER_MANUAL, CLIENT_GUIDE) and is cheap to fix. |
| Drop `/team` and operations from v1 | Rejected by DEC-03 in favour of the experimental label. This spec still fixes AGT-02a, because data loss in a shipped command is not acceptable even when it is labelled experimental. |

## 7. Acceptance criteria

| ID | Check |
|---|---|
| ACC-CONT-01 | Gateway fixture: the second request of `run --resume <id>` contains the first turn's messages, and `result.taskId` equals the recovered id. |
| ACC-CONT-02 | `run --resume` (no id) resumes the latest task for the workspace. With none, exit 2 with guidance. |
| ACC-CONT-03 | Operation rig with a small `contextLimit` forcing compaction; SIGKILL; resume. `<task>.history.jsonl` contains the compaction id, and `read_archive` returns the originals. |
| ACC-CONT-04 | Resume a unit after two identical loops. A third repetition triggers the recovery note, not a fresh count. |
| ACC-CONT-05 | R4 reproduction: parent `requests` equals gateway requests, and the task file count increases by 1 only. |
| ACC-CONT-06 | Inject a throwing `admitContext` after a write. The result has `pending=true`, `reason=UNHANDLED_ERROR`, and `onSteering` received a cancelled notice. |
| ACC-CONT-07 | An implementer unit replying in prose only gives BLOCKED(no_change) with three options. |
| ACC-CONT-08 | 200-step scripted run with 2 KB outputs: per-step persistence overhead p95 recorded (MEASUREMENT). Threshold 100 ms on SSD. |
| ACC-CONT-09 | Unknown state identity + 14 distinct writes gives no STAGNATION_DETECTED. 13 identical writes do stagnate. |
| ACC-CONT-10 | An independent reviewer report on compaction/continuity and truncation recovery against the RC build, including one live long task (≥ 60 steps, ≥ 2 compactions). |

## 8. Dependencies

- DEC-03 (resolved): team and operation ship as experimental.
- SPEC-08 handles schema/corruption rules if §3.7 triggers a schema change.
- SPEC-10 hosts the live long-task evidence.
