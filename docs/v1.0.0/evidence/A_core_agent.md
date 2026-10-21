# SCOPE A — Core agent behavior (AGT-)

Snapshot: `$SNAP=/tmp/claude-1000/-home-mike-nexus-code/b79a4439-e6ad-4986-aa16-4a81f838ac71/scratchpad/snap` (HEAD db1ca55). All line refs are `cli/src/...` in the snapshot.
Status: written incrementally (audit was interrupted once by a usage limit).

## 1. Coverage ledger

| File | Method |
|---|---|
| src/agent.ts (5439) | full read |
| src/core/turn.ts | full read |
| src/core/app.ts | full read |
| src/core/execution_tracking.ts | full read |
| src/core/objective.ts | full read |
| src/core/provider_recovery.ts | full read |
| src/core/state.ts | targeted read (lines 260-860: manager, progress, recovery) |
| src/core/spine.ts | targeted read (execute pipeline 230-621) |
| src/core/operation_runner.ts | full read |
| src/team.ts | full read |
| src/core/candidate.ts | targeted (computeCandidateIdentitySync) |
| src/config.ts | targeted (maxSteps, continuationBudget) |
| src/types.ts | targeted (DEFAULT_CONTINUATION) |
| src/index.ts | targeted (`run --resume`) |
| src/core/operation.ts, findings.ts, parser.ts, evaluator.ts, tester.ts, synthesizer.ts, stager.ts, tokens.ts, knowledge.ts | see appendix (section 9) |
| test/durable_continuity.test.ts | targeted (gateway fixture, resume test) |
| docs/COMPACTION_AND_CONTINUITY.md, docs/EXECUTION_CONVERGENCE.md | see section 9 |

## 2. Architecture / data-flow notes

- `AutonomousAgent.runTurn` (agent.ts:4254-4995) is the single main loop. Per step: steering drain (4450) -> capability refresh (4555) -> `admitWithFindings` (compaction ladder + model-written findings, 2767) -> `measureAdmission` (provider token count, 2237) -> `ProviderRecoveryController.run` around streaming inference (4614) -> parse -> tool dispatch (parallel only if every call is in `READ_ONLY_TOOLS`, 4800; else sequential with approval) -> `observe` into `ExecutionTracker` -> `endStep` (progress evaluation + durable `persistProgress`).
- Stop conditions: `task_completed` success, FINAL_TEXT (after up to `maxCompletionNudges`=2 nudges while requirements are open), cancellation (AbortController; in-flight tool awaited), inference failure after recovery, context admission refusal (BLOCKED), persistence failure, stagnation (`stagnationSteps`=12 consecutive no-progress steps, or a repeated loop after `maxRecoveries`=2 notes), operator step/time budgets (default +Infinity, types.ts:127-133), `--no-continuation` (maxSteps, default 30, as a hard LIMIT_REACHED).
- Default turn has **no cumulative step ceiling**: `maxSteps`=30 is a segment (durable checkpoint) only (agent.ts:4379-4381, 4435). Confirmed.
- Outcome derivation is centralised in `buildTurnResult` (5007-5173) with invariants in `assertTurnResultInvariants` (turn.ts:318). Exit codes: 0 VERIFIED/NOT_REQUIRED, 2 REGRESSION_FREE/UNVERIFIED, 130 interrupted, 1 otherwise.
- Verification gate lives in the `task_completed` handler (3345-3571): open/blocked requirements refuse; configured or discovered verifier runs; prior FAILED on identical inputs is not rerun; discovered-verifier pass is VERIFIED only with fail-before/pass-after independence.
- Durable state: `~/.nexus/tasks/<task>.json` written via full load+redact+atomic write on every progress event (state.ts recordProgress/recordOperationStart/End). Compaction originals go to `<task>.history.jsonl` before the record names the compaction.
- Three agent kinds share the class: depth 0 (interactive/run; durable, has objective ledger), depth 1 work units (`AgentWorkUnitExecutor`, durable, resumed from task state, **no objective ledger**), depth 1/2 in-turn subagents (`runSubagent`, separate loop, declared non-durable).

## 3. Findings

(see table below; populated incrementally)

| ID | Sev | Workflow | Location | Evidence | User impact | Disposition |
|---|---|---|---|---|---|---|
| AGT-01 | S2 | `nexus run --resume [id]` | core/app.ts:174-177, agent.ts:5236, index.ts:176 | RUNTIME (R2). `runTask` recovers the task (`recoverFromTaskState` restores messages/objective), then `agent.run()` calls `resetConversation()` unconditionally: the resumed request carried 2 messages (system+new prompt), none of the prior conversation; `objective` is also cleared. Only the unverified-change obligation survives (that is all `durable_continuity.test.ts:254` asserts). The result's `taskId` is captured before recovery (app.ts:174), so the result/session is keyed `task-ba261ade` while the recovered state is `task-02d1fbd5`. `--resume` with no id passes the literal `"latest"` → `Task state not found for task ID 'latest'` → task fails. | Headline "resume" for one-shot runs does not resume; a crash-resume of `run` silently restarts from scratch with a new id; `--resume` without id always fails. | Fix before v1: skip reset when resuming, use recovered id, resolve `latest` (or remove flag). Add test asserting prior messages are sent. |
| AGT-02 | S2 | `/team`, `nexus operation run/resume` (work units) | agent.ts:3081 (`durableUnit = this.depth === 0`), 3127, 1136-1139, 4389, 1489-1501; operation_runner.ts:559 | SOURCE + DOC-CLAIM. Work units run as `new AutonomousAgent(config, 1)` and ARE durable (resumed via `recoverFromTaskState`), but every depth-gated rule treats depth 1 as a non-durable in-turn subagent: (a) compaction is applied in memory only — no archive append, no checkpoint, never `PERSISTENCE_FAILED`; the next `persistProgress` then writes the compacted conversation and a `committedCompactions` id that has no archive lines, so originals are lost and `read_archive` cannot return them after resume (contradicts COMPACTION_AND_CONTINUITY.md:145-160 "Every compaction ... is committed in a fixed order"); (b) no objective ledger: no requirement gating, no steering, `update_requirements`/`read_objective` not offered; (c) `ExecutionTracker.fresh()` per turn, so loop/stagnation history and cumulative steps reset at every resume/retry; (d) no change baseline / independence judgement (`captureChangeBaseline` depth 0 only, 4034) so discovered-verifier passes are at best REGRESSION_FREE. `runningAsSubagent` already distinguishes the two cases (5003). | Long team/operation units lose compaction originals and convergence history across resume; doc claims overstate durability. | Gate on `runningAsSubagent` (non-durable) instead of `depth`; add a work-unit compaction+resume test asserting archive lines exist. |
| AGT-03 | S3 | spawn_subagent token accounting | agent.ts:5298-5431, 1869, 2863 | RUNTIME (R4): gateway received 4 inference requests, parent `getTokenStats().requests` = 2. `runSubagent` never adds to `totalTokens` and the parent never merges the child's; `recordFindings` adds tokens but not `requests`. | `/tokens`, receipts and cloud spend views under-report delegated work. | Merge child stats into parent; count findings calls. |
| AGT-04 | S3 | spawn_subagent durability | agent.ts:1148 (`initTaskState` in ctor), 1587-1590 | RUNTIME (R4): `~/.nexus/tasks` grew 4→6 for one parent turn with one subagent (parent + subagent record). In-turn subagents are documented as non-durable (3068, 5291) yet write a task record (and progress writes) under a random id that nothing resumes or deletes. | Orphan records accumulate; `listTasks`/resume pickers show phantom tasks. | Skip persistence when `runningAsSubagent`/depth>0 in-turn. |
| AGT-05 | S3 | Duplicated subagent loop | agent.ts:5298-5431 vs 4401-4915 | SOURCE. Second loop diverges: no `refreshCapabilities`/`measureAdmission` (provider token counting, strict counting ignored), no empty-reply retry (first empty reply = "stopped without a report"), no backoff for polls, no steering, offers `[...HARNESS_TOOLS, read_findings]` (all tool groups, no MCP/plugin) while parsing against `getEffectiveTools()` names (5362) — offered and accepted tool sets differ; no cancellation-record semantics for in-flight tools. | Behaviour of delegated work differs subtly from main turns; context/strict-count guarantees don't hold inside subagents. | Refactor to one step function shared by both loops (RELEASE-REQUIRED or documented limitation). |
| AGT-06 | S4 | spawn_subagent obligation write | agent.ts:3610-3617 vs 3635-3641 | SOURCE. `turnMutations` added twice (try and finally). `this.hasPendingModifications = true` assigned directly, so the later `setUnverifiedChanges(true)` short-circuits (1588) and the immediate durable obligation write is skipped; it is persisted only at the next `persistProgress({messages:true})` (4893). | Small crash window where a subagent's write is not durably an obligation; counter inflation harmless today (only `>0` tested). | Use `setUnverifiedChanges` once; count once. |
| AGT-07 | S3 | Team step bound (doc vs code) | team.ts:26-27,91; EXECUTION_CONVERGENCE.md:117-118; config.ts:189-205 | SOURCE + DOC-CLAIM. Doc says units are "capped at 15 steps". With default continuation (`maxTotalSteps=+Inf`) 15 is only a segment size; units run until completion/stagnation/cancel. Under `--no-continuation` it becomes a hard LIMIT_REACHED. Not an arbitrary ceiling in the default path (good), but doc is wrong and `ROLE_MAX_STEPS` comment ("step bound the team has always used") misleads. | Operators misjudge cost/duration of team runs. | Fix doc/comment. |
| AGT-08 | S3 | Unhandled errors in a turn | agent.ts:4570, 4655-4657, 4992; turn.ts:444-460; app.ts:229 | SOURCE. Non-`ContextBudgetError`/`InferenceError` exceptions in admission, and any `ContextBudgetError` surfacing from inference, are rethrown out of `runTurn`: no final checkpoint/ledger outcome, queued steering never reported cancelled (observer left hanging), queued /compact never reported. `failedTurnFromError` hard-codes `unverifiedChangesPending: false` and `steps.used: 0`. | A crash-type turn can report "no pending changes" while the workspace holds unverified edits. | Wrap loop body: build a FAILED/UNHANDLED_ERROR result in-agent with real obligation, cancel steering/compaction queues. |
| AGT-09 | S3 | Stagnation false positive on large repos | agent.ts:2026-2047 (1.5 s budget), execution_tracking.ts observe()/evaluateStep() | INFERENCE. Once state identity exceeds 1.5 s it is "unknown" for the rest of the turn; then mutate-kind calls are never `informative` and "new state" cannot be shown, so a run of ≥12 steps that only write/edit files (e.g. generating many files) counts as no progress → `STAGNATION_DETECTED`. | Productive long edit sequences stopped on big monorepos. | Treat successful mutations with distinct args as progress when state is unknown; add test. |
| AGT-10 | S3 | Knowledge auto-extraction | knowledge.ts:34-43, 206-231; agent.ts:4934-4936, 3302 | SOURCE. After every depth-0 turn `autoExtract(promptText)` stores prompt fragments matching `always|never|do not|must …` / `use|run|prefer npm|cargo…` as permanent "rule"/"idiom" entries in `<workspace>/.nexus/knowledge.json`, which `buildSystemPrompt` injects into every future session. Constructor `mkdir`s `<workspace>/.nexus` even in `--read-only`. A workspace-supplied `knowledge.json` is injected without the workspace-trust gate applied to MCP/plugins. | Silent standing instructions from one-off prompts ("never run the tests" in a task) or from a cloned repo; read-only mode writes into the workspace. | Make opt-in; no writes in read-only; trust-gate injection. |
| AGT-11 | S3 | Team/unit outcome semantics | operation_runner.ts:651-663; turn.ts:358-370 | SOURCE. `classify` marks a unit COMPLETE on `turnSucceeded`, which includes `NOT_REQUIRED` (no changes, FINAL_TEXT). An `implementer`/`tester` unit that answers in prose without changing or verifying anything is COMPLETE and its dependents run. | Team "COMPLETE" can mean nothing was implemented. | Role-aware success (implementation units require a change + non-UNVERIFIED outcome) or decision. |
| AGT-12 | S4 | Operation runner safety bound | operation_runner.ts:95-137 | SOURCE. 10 000 scheduler transitions → BLOCKED with a decision whose `options: []`; `nexus operation decide` has nothing to apply. Bound itself is a resource-safety valve, not a work ceiling. | Rare dead-end state. | Offer resume/stop options. |
| AGT-13 | S4 | Verifier attempt numbering | core/objective.ts recordAttempt (n = length+1 after slice to 50) | SOURCE. After 50 attempts every new attempt is `#51`; `verifiedBy.attempt` becomes ambiguous. | Receipts cite non-unique attempt numbers. | Monotonic counter. |
| AGT-14 | S4 | Swallowed durable-write errors | agent.ts:4022-4032, 4051-4058, 3836-3840, 3853-3867, 4240-4243, 1182-1185 | SOURCE. `recordOperationStart/End`, plan/requirements checkpoints, provider-recovery checkpoints `catch {}` silently (unlike `persistProgress`, which reports once). Failure of `recordOperationStart` removes crash detection of an in-flight tool without telling anyone. | Recovery may miss an interrupted tool. | Route through the same reported-failure path. |
| AGT-15 | S4 | Persistence cost | state.ts recordProgress/recordOperationStart/End (load+redact+fsync rewrite of entire task JSON incl. messages) | INFERENCE/MEASUREMENT gap. ≥3 full-state rewrites per tool call, each O(conversation) with redaction scan and fsync. | Latency on long conversations / slow disks. | Measure (see §6). |
| AGT-16 | S4 | Turn-end side effects | agent.ts:773-780, 4932 | SOURCE. Every turn spawns `notify-send` via a shell and writes BEL to stdout, including JSON/sidecar/headless runs (constant args, no injection). | Noise; possible stray byte on protocol stdout (sidecar not checked — §6). | Gate on interactive TTY. |
| AGT-17 | S4 | `deepFreezeTurn` | turn.ts:353-355 | SOURCE. Shallow `Object.freeze`; nested `verification`, `steps`, etc. remain mutable. | Low. | Rename or deep-freeze. |

Proven defects (reproduced or unambiguous in source): AGT-01, 02, 03, 04, 06, 08 (pending:false), 10, 11, 12, 13. Inference/qualification: AGT-09, 15, 16 (sidecar effect).

## 4. Reproductions

Harness: `$SCRATCH/repro/agt_repro.test.ts` (scripted OpenAI-compatible gateway copied from `test/durable_continuity.test.ts`, real `AutonomousAgent`/`ApplicationCore` from the snapshot, isolated `HOME`, temp git repo).

```
cd $SNAP/cli && npx tsx --test --test-concurrency=1 ../../repro/agt_repro.test.ts
R1 file: "changed\n" git: M notes.txt
R1 result: COMPLETED UNVERIFIED NO_APPLICABLE_VERIFIER pending= true      # NOT a defect (see §5)
R2 r1.taskId= task-02d1fbd5 r2.taskId= task-ba261ade msgs in resumed request= 2 carries prior conversation= false   # AGT-01
R2 resume 'latest': Task state not found for task ID 'latest' at path: /tmp/agt-home-.../.nexus/tasks/latest.json   # AGT-01
R4 outcome COMPLETED NOT_REQUIRED task files before/after 4 6 gateway requests total 4 subagent requests 2 parent tokenStats.requests 2   # AGT-03, AGT-04
```

## 5. Strengths (with evidence)

- No default cumulative step ceiling: `DEFAULT_CONTINUATION.maxTotalSteps/maxTurnMinutes = +Infinity` (types.ts:127-133); `maxSteps` is a segment/checkpoint (agent.ts:4379-4381, 4435-4445). Step-position notices only appear under an operator-set limit (`stepPosition`, 766; `stepNotedContent` 2932-2933). Subagents have no step allowance; model-supplied `max_steps` ignored (3584-3585). Recovery/iteration bounds that remain (provider `maxIterations` 1000, operation runner 10 000, compaction attempts 5) are resource-safety valves with explicit reasons, not completion substitutes.
- Stagnation is evidence-based (action/outcome/state triples with volatile-token normalization, polls vs loops, compaction-reacquisition excluded as thrash), persisted in the objective ledger across compaction/turns/restart for depth-0 (execution_tracking.ts; objective.ts `trackingOf`).
- Outcome honesty: `buildTurnResult` is the single derivation; invariants forbid VERIFIED/REGRESSION_FREE without PASSED evidence and NOT_REQUIRED with pending changes (turn.ts:318-351). Discovered-verifier passes need fail-before/pass-after independence for VERIFIED (agent.ts:3447, 5136-5145); non-covering passes are REGRESSION_FREE (5126-5135); read-only answers resting on compacted-away output are UNVERIFIED/CONTEXT_EVIDENCE_NOT_RETAINED (5165-5171). `verified` requirements must bind a passing, unfiltered, deliverable-bound, independent run (objective.ts applyRequirementUpdates).
- Failed mutating commands still create the obligation (R1: `exit 3` after modifying a file → `pending=true`, UNVERIFIED) because run_command reports `success` with an exit_code body and the spine's mutation hook fires on tool success.
- Cancellation: authority event with per-phase interruption records; no new dispatch after abort; undispatched calls get synthetic tool results so history stays well-formed (4359-4372, 4737-4741, 4841-4850).
- Provider recovery separates waiting/probing from replay; UNKNOWN execution replayed at most `maxUnknownReplays` after a probe; NOT_EXECUTED can yield to the scheduler (provider_recovery.ts).
- Compaction commit protocol for depth-0 (archive → switch → records; non-durable compaction stops the turn) is implemented as documented (agent.ts:3070-3153).
- Steering: queued, applied once at step boundaries, never dropped silently (cancelled + reported), survives restore (1935-1973, 1553-1557).
- Truncated replies (finish_reason=length) get one in-turn retry with a precise notice; second in a row ends the turn (4672-4683).

## 6. Qualification gaps (not proven either way) + procedure

| Gap | Procedure |
|---|---|
| Persistence latency on long conversations (AGT-15) | Script a 200-step gateway run with ~2 KB tool outputs; record per-step wall time and `strace -c -f -e fsync,rename` counts; accept if p95 step overhead < 100 ms on SSD. |
| Large-repo stagnation false positive (AGT-09) | In a repo where `computeCandidateIdentitySync` > 1.5 s (or stub `workspaceStateIdentity` to "unknown"), script 14 consecutive distinct `write_file` steps; expect no STAGNATION_DETECTED. |
| Work-unit compaction loss (AGT-02) | Operation rig (durable_continuity.test.ts `operationRig`) with `contextLimit` small enough to force compaction; kill and resume; assert `<task>.history.jsonl` has the compaction id and `read_archive` returns originals. |
| BEL/notify-send on sidecar stdout (AGT-16) | Run `SidecarServer` with real stdout writer; capture raw stdout bytes for `\x07` outside JSON lines. (sidecar out of my scope.) |
| Crash mid-tool → recovery for depth-0 `run` | Covered only for operations; after AGT-01 fix, kill a `nexus run` during a long `run_command`, `--resume`, assert interrupted-op note and obligation. |
| Subagent cancellation latency | Cancel parent while subagent in long tool; assert parent INTERRUPTED and child stops dispatching (signal is shared; not exercised here). |
| Docs not fully re-verified | Only claims relevant to findings (resume, compaction commit, team 15-step cap) were checked against code; remaining claims in COMPACTION_AND_CONTINUITY.md/EXECUTION_CONVERGENCE.md are UNVERIFIED by this audit. |

## 7. Proposed v1.0.0 requirements

| ID | Requirement | Rationale | Blocker? | Acceptance test |
|---|---|---|---|---|
| AGT-R1 | `nexus run --resume <id>` continues the recovered conversation, objective and task id; `--resume` with no id resolves the latest task for the workspace or is rejected at parse time. | workflow/failure (AGT-01) | BLOCKER | Gateway test: second request contains first turn's messages; result.taskId == recovered id; `--resume` alone works. |
| AGT-R2 | Every durable unit (depth-0 turn and work unit) commits compactions via archive→switch→records and stops on non-durable compaction; only in-turn subagents are memory-only. | continuity (AGT-02) | BLOCKER | Work-unit compaction + kill + resume test asserting archive lines and `read_archive`. |
| AGT-R3 | Work units keep execution tracking (loops, stagnation, cumulative steps) across resume. | failure/convergence (AGT-02c) | RELEASE-REQUIRED | Resume a unit after 2 identical loops; third repetition triggers recovery note, not a fresh count. |
| AGT-R4 | Token/request accounting includes subagent and findings-distillation inference. | compat/cost (AGT-03) | RELEASE-REQUIRED | R4 repro: parent requests == gateway requests. |
| AGT-R5 | In-turn subagents write no durable task records. | hygiene (AGT-04) | RELEASE-REQUIRED | R4 repro: task file count +1 only. |
| AGT-R6 | Any exception escaping the loop yields an agent-built FAILED/UNHANDLED_ERROR TurnResult with the true `unverifiedChangesPending`, final checkpoint, and cancelled steering/compaction notifications. | safety/failure (AGT-08) | RELEASE-REQUIRED | Inject a throwing `admitContext` after a write; assert pending=true and onSteering cancelled. |
| AGT-R7 | Team/operation units of implementation/verification roles cannot become COMPLETE with NOT_REQUIRED (no change) without an operator decision. | honesty (AGT-11) | RELEASE-REQUIRED | Implementer unit replying prose-only → BLOCKED decision. |
| AGT-R8 | No implicit standing rules from prompts; no workspace writes in read-only mode; workspace-supplied knowledge gated by workspace trust. | safety (AGT-10) | RELEASE-REQUIRED | Read-only run leaves no `.nexus/`; prompt "never run tests" does not appear in next session's system prompt. |
| AGT-R9 | Main and subagent loops share one step implementation (admission, counting, tool-set offered == accepted). | maintainability/consistency (AGT-05) | POST-V1 (document divergence for v1) | Parity test: same scripted gateway produces same admission logs in both loops. |
| AGT-R10 | Docs match code on team step semantics and durability. | doc honesty (AGT-07, AGT-02) | RELEASE-REQUIRED | Doc review against config defaults. |
| AGT-R11 | Durable-write failures (op start/end, plan, requirements, recovery) are reported like progress-save failures. | failure visibility (AGT-14) | POST-V1 | Fault-inject saveTaskState; assert notice + `persistence.failures`. |

## 8. Commands run

- `wc -l` / `sed -n` / `grep -n` / `cat -n` reads over `$SNAP/cli/src/{agent.ts,core/*.ts,team.ts,config.ts,types.ts,index.ts,knowledge.ts}`, `$SNAP/docs/*.md`, `$SNAP/cli/test/durable_continuity.test.ts`.
- `cd $SNAP/cli && npx tsx --test --test-concurrency=1 ../../repro/agt_repro.test.ts` (3 targeted repro tests; first attempt failed on top-level-await import, fixed to static imports). No full suite run.

## 9. Appendix — files not fully reviewed

`core/operation.ts`, `core/findings.ts`, `core/candidate.ts` (beyond identity), `parser.ts`, `evaluator.ts`, `tester.ts`, `synthesizer.ts`, `stager.ts`, `tokens.ts`: not read in full (token budget after an interruption). Usage check only: `evaluator` imported only by `index.ts`; `stager` by index/repl/slash; `parser` only by agent.ts. Their tests were not run. Treat as UNREVIEWED for v1 sign-off; recommend a follow-up pass on `parser.ts` (tool-call contract, text-embedded tool calls) and `tester.ts` (`isVerifierDeliverableBound`, `hasExecutedTests`), which directly decide VERIFIED/REGRESSION_FREE.
