# PLAN-04: Task continuity, resume and durable work units

This plan implements [SPEC-04](../specs/SPEC-04-continuity-and-durable-work.md) in milestone **M3**.

- Requirements: REQ-AGT-101 to 108, 110, and 111 (partial).
- Decision: DEC-03 (team/operation ship as experimental).

## Safe change boundary

- `cli/src/agent.ts`: constructor; `run()` at 5236; durability gates; `runSubagent` at 5298-5431; `runTurn` wrapper.
- `cli/src/core/app.ts:174-229`
- `cli/src/index.ts:176` and the `--resume` handling
- `cli/src/core/turn.ts:444-460`
- `cli/src/core/execution_tracking.ts`
- `cli/src/core/operation_runner.ts:95-137,559,651-663`
- `cli/src/team.ts`
- `cli/src/core/objective.ts` (attempt counter)
- `cli/src/core/state.ts` (failure reporting)
- `docs/EXECUTION_CONVERGENCE.md`, `docs/COMPACTION_AND_CONTINUITY.md`

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | `run(prompt, {resume})` skips `resetConversation` and keeps the objective; `runTask` takes the recovered taskId; `--resume` with no id resolves the latest task in the workspace, otherwise exits 2 with guidance. | `agent.ts:5236`; `app.ts:174-177`; `index.ts:176`; `state.ts` (`listTasks` by workspace) | — |
| 2 | Add a `durable` property and replace the depth gates. Classify each site in the PR description (one line each). | `agent.ts:1136-1139,1148,1489-1501,1587-1590,3081,3127,4034,4389`; `AgentWorkUnitExecutor` | — |
| 3 | Give work units an objective ledger keyed by unit id; offer `update_requirements`/`read_objective` to implementer and tester roles. | `agent.ts`, `objective.ts`, `team.ts` | 2 |
| 4 | Persist execution tracking and the change baseline for durable units, and restore them on resume. | `execution_tracking.ts` (`fresh()` call sites), `objective.ts trackingOf` | 2 |
| 5 | Subagent stats merge; `recordFindings` counts requests; no task record when not durable. | `agent.ts:1869,2863,5298-5431` | 2 |
| 6 | Call `measureAdmission` in the subagent loop and make the offered tool set equal the accepted set. Document the remaining divergences. **Done at source** (`runSubagent` + `EXECUTION_CONVERGENCE.md` §10); regression: `cli/test/agt111_subagent_parity.test.ts`. Ledger row update blocked on REQUIREMENTS file claim at authoring. | `agent.ts` `runSubagent` | 5 |
| 7 | Fix the obligation write to call `setUnverifiedChanges` once and count once. | `agent.ts:3610-3641` | — |
| 8 | Wrap `runTurn` and build an `UNHANDLED_ERROR` result in-agent; final checkpoint; cancel the steering and compaction queues with notices. | `agent.ts:4254-4995`; `turn.ts:444-460`; `app.ts:229` | — |
| 9 | Stagnation rule for unknown state identity (distinct successful writes count as progress), plus the inverse test. | `execution_tracking.ts evaluateStep` | — |
| 10 | Role-aware unit classification: a NOT_REQUIRED result from an implementer or tester unit becomes BLOCKED(no_change); give the 10k-transition stop real options. | `operation_runner.ts:95-137,651-663` | — |
| 11 | Make the attempt counter monotonic. | `objective.ts recordAttempt` | — |
| 12 | Route all durable-write failures through `reportPersistenceFailure`. | `agent.ts:1182-1185,3836-3867,4022-4058,4240-4243` | — |
| 13 | Persistence cost measurement harness (ACC-CONT-08). If over threshold, open a follow-up for the split-record schema (SPEC-04 §3.7 / SPEC-08). | new `cli/test/perf/persistence_cost.bench.ts` (not in the default suite) | — |
| 14 | Experimental labels for `/team` and `nexus operation` in help and docs; correct the team-steps doc; describe compaction behaviour for work units. | `index.ts`, slash catalog, `EXECUTION_CONVERGENCE.md:117-118`, `COMPACTION_AND_CONTINUITY.md` | 2 |

## PR slices

| PR | Tasks | Notes |
|---|---|---|
| PR-4a | 1 | Resume fix. This is a blocker; land it first. |
| PR-4b | 2, 4 | Durability property and persisted tracking. Blocker AGT-02a. |
| PR-4c | 3, 10 | Unit ledger and outcome semantics. |
| PR-4d | 5, 6, 7 | Subagent hygiene. |
| PR-4e | 8, 12 | Error path and failure reporting. |
| PR-4f | 9, 11, 13, 14 | Stagnation, counter, measurement and docs. |

## Tests

- Extend `durable_continuity.test.ts` with the resume-conversation assertion and the `latest` case (ACC-CONT-01/02). Port the R2 case from `evidence/repro/agt_repro.test.ts`.
- Use the `operationRig` with a small `contextLimit`, SIGKILL, then resume. Assert the archive lines and `read_archive` (ACC-CONT-03), plus loop persistence (ACC-CONT-04).
- R4 port for accounting and records (ACC-CONT-05).
- Fault injection: stub `admitContext` to throw (ACC-CONT-06).
- `team_convergence.test.ts`: an implementer that replies with prose only (ACC-CONT-07).
- `execution_tracking.test.ts`: unknown-identity cases (ACC-CONT-09).
- **Live (M5):** one long task with at least 60 steps and at least 2 compactions on the RC, run independently (ACC-CONT-10).

## Rollback

Each PR stands alone. PR-4b changes durable behaviour for units; reverting it restores the alpha.2 semantics. No schema change unless task 13 triggers one.

## Definition of done

- ACC-CONT-01 to 09 pass in CI.
- ACC-CONT-10 is recorded in M5.
- Ledger rows are updated.
- The doc corrections are merged.
