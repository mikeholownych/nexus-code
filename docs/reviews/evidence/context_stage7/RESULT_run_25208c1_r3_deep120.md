# run_25208c1_r3_deep120 — R3 (outgrown-findings notice states the cost of deferring the write), 120 steps

Independent read-only fact-check, 2026-10-13, against context exit criterion 6 of the qualification assessment
(artifact produced, verifier passes, **no false absence claims**, d88a897 facts correct). Run records:
`~/df2/postdog/dogfood/run_25208c1_r3_deep120/` (events.jsonl, session.json); artifact in the workspace below.

**Identity / configuration.** Candidate 25208c1 (25208c1cd327…; core tree 9cf04a26); harness-core 08b78903…, nexus-tui
779a3fac…; workspace `~/df2/postdog/dogfood_ws_25208c1_r3` (HEAD 25208c1, clean at provisioning); model
engineering/deep via the appliance gateway, 64k context, reserves 8192/4096; objective a3a81ae7; authoritative verifier
`node ~/df2/postdog/verify/review_verifier.mjs --base 25208c1… --objective …/objective.txt`;
`-s 120 --max-total-steps 120 --max-turn-minutes 420`; 16:01Z–20:50Z (4 h 49 m).

## Outcome

- **COMPLETED / VERIFIED at step 108/120**: `"heading":"TASK COMPLETED - VERIFIED"`, `modelStop: TASK_COMPLETED_TOOL`,
  `objective.status: completed`; all ten requirements "IMPLEMENTED (model-reported)".
- Provider recovery once: a mid-stream `timeout` frame at step 89 left execution UNKNOWN; replayed once
  (`maxUnknownReplays: 2`), resumed 20:00:39Z.
- Writes at steps 52, 73, 86 (write_file) and 93–98 (edit_file); one task_completed at 108. First write at step 52
  (R2: 103; d88a897: 40).
- Final-report inconsistency: the summary lists F-3 as HIGH (artifact: MEDIUM), names a non-existent
  `cli/src/core/checkpoint.ts` and omits `findings.ts`.

## Verifier

PASSED in the run (source configured). Independent rerun from the workspace: **21/21 checks pass**, exit 0. Gap: "every
cited line reference is within its file" passed although the artifact cites "`cli/src/tools.ts` around line 2821" and
tools.ts has 787 lines — the verifier does not parse "file around line N".

## Artifact

`docs/DOGFOOD_ARCHITECTURE_REVIEW.md`, 324 lines, untracked; all requested sections; F-1…F-8 (4 MEDIUM, 2 LOW,
2 INFORMATIONAL); disposition `NEXUS_DOGFOOD_REVIEW_READY_WITH_FOLLOWUPS`.

## Spot-check (workspace source at 25208c1)

| Claim | Artifact | Verdict | Evidence |
|---|---|---|---|
| `cli/src/core` = 17 files / 9087 lines, per-file sizes | L34–37 | TRUE | `wc -l cli/src/core/*.ts` |
| `agent.ts` 4340 lines, largest source module | L38 | TRUE | larger files are tests/dist only |
| 51 test files + five named helpers | L39–40 | TRUE | `ls cli/test/*.test.ts` |
| `npm test` 768 tests / 128 suites pass | L42 | Supported by run record, not rerun | session.json |
| `calculateContextBudget` at tokens.ts:54 | L20, L100 | TRUE | tokens.ts:54 |
| `runTurn` 3390; 3399 delegates | L48–50 | PARTIAL | delegation at 3396; 3399 is the activeTurn guard |
| ExecutionState 5 values; invariants/deepFreeze | L51–53 | TRUE | core/turn.ts:15, 257, 285 |
| WorkUnitStatus 6 states; COMPLETE rule at 428 | L54–55 | TRUE | operation.ts:42, 428 |
| Runner methods and limits | L56–59 | TRUE | operation_runner.ts:84–225 |
| /team ROLE_MAX_STEPS 15, teamUnits, driveOperation | L62–64 | TRUE | team.ts:27, 34, 46, 91–92 |
| `runSubagent` "reachable from `cli/src/tools.ts` around line 2821" | L65–66 | **FALSE** (file) | tools.ts has 787 lines; caller is agent.ts:2821 |
| `probeAvailability` client.ts:878, GET /models | L68, L122 | TRUE | client.ts:878, 886 |
| Spine API names | L70–73 | TRUE | core/spine.ts |
| atomic `saveTaskState`; schema version 1 | L79–80 | TRUE | state.ts:27, 365, 376 |
| `TaskRecoveryResult` fields | L81–85 | TRUE | state.ts:235–264, 755 |
| Operation lock rules | L86–89 | TRUE | operation_runner.ts:339–363 |
| `latestResumable`; listTasks by mtime | L90–92 | TRUE | operation_runner.ts:366–368; state.ts:810 |
| `reconcileInterruptedRuns`; no FAILED unit state | L93–95 | TRUE | operation.ts:42, 668–698 |
| Admission/compaction symbols and lines | L99–106 | TRUE | agent.ts at the cited lines |
| `capacity_fixture.ts` exercises 13496/13566/13894 and reserves 2/4/6 | L108–109 | **FALSE** | strings absent from the fixture; numbers from test console output, 2/4/6 were message counts |
| resources.ts / provider_recovery.ts / client.ts credentials / egress.ts / persistence_protection.ts symbols | L113–142 | TRUE | cited lines |
| `buildTurnResult` 3992 and cause codes | L150–156 | TRUE | agent.ts:3992–4150 |
| doctor.ts:958–959 stale-lock cleanup | L178–179 | TRUE | |
| model_catalog.ts:131–132 "transitional compatibility code", try/catch at 170 | L176–177 | **FALSE** | 131 is the provider named `"compatible"`; 170 is an `if`, not a try/catch |
| search_web.ts:51 "compatibility shim" | L180 | **FALSE** | User-Agent string "(compatible; NexusCode/1.0)" |
| session.ts:106 shim | L180 | PARTIAL | `loadSession` legacy migration |
| F-1: team.ts:106 `success = status === "COMPLETE"` | L186–187 | PARTIAL | at team.ts:100 |
| F-1: three *independent* completion implementations | L196–198 | **FALSE** | `subagentResult` uses buildTurnResult + turnSucceeded (agent.ts:4336–4338) |
| F-1: subagent path "cannot express" BLOCKED/LIMIT_REACHED | L202–203 | PARTIAL | carried as reason text (agent.ts:4331, 4338) |
| F-2: team step-cap exhaustion has no durable cause code | L210–214 | **FALSE** | LIMIT_REACHED → failed/EXECUTION_FAILED + operator question (operation_runner.ts:686–703) → `block()` (operation.ts:675–676) |
| F-3: resume target chosen by mtime | L219–221 | TRUE (mechanism) | operation_runner.ts:366–368 |
| F-3: consequence; "the only substrate blocker" | L222–224, L293–295 | PARTIAL | only for `resume` without an id; `run` prints the exact id (operation_cli.ts:118–127) |
| F-4: provenance only in `compactConversation`, empty id lists | L230–233 | TRUE | agent.ts:2527–2530 |
| F-4: automatic path has no provenance | L233–238 | PARTIAL | in-memory provenance with ids exists (agent.ts:2105–2122, 2167), not serialized |
| F-5: takeover is two non-atomic steps | L244–249 | TRUE | operation_runner.ts:355–356 |
| F-5: staleness = other host OR (pid dead AND not pre-boot) | L246 | **FALSE** | other host ⇒ held (throws); stale = same host AND (pid dead OR pre-boot) — operation_runner.ts:352 |
| F-6: alias fields rewritten on every save | L257–259 | TRUE | state.ts:331–333 |
| F-6: alias reader can disagree with writer | L260–261 | UNSUPPORTED | writer resets both |
| F-6: catalog failures "caught and hidden" | L261–262 | **FALSE** | recorded as entry.status/entry.error (model_catalog.ts:144–152) |
| F-7: `maxUnknownReplays: 0`, `maxIterations: 0` | L268–269 | TRUE | resources.ts:116–117 (RECHECK_POLICY) |
| F-7: ambiguous execution "never blindly replayed" | L270–272 | **FALSE** | RECHECK_POLICY is backoff only; turn default `maxUnknownReplays: 2` (provider_recovery.ts:157); this run replayed at step 89 |
| F-8: agent.ts responsibilities/lines | L278–280 | TRUE | |

## Absence-claim audit

| Absence claim | Verdict |
|---|---|
| no FAILED work-unit state (L95, L302) | TRUE |
| automatic reduction writes no durable provenance record (L106–107) | TRUE for the durable field |
| spine: no orphaned abstractions (L173–175) | TRUE |
| F-1: suspected divergence does not exist (L199) | TRUE |
| F-1: subagent "cannot express" BLOCKED/LIMIT_REACHED (L203) | PARTIAL |
| **F-2: no durable cause code (L211–212)** | **FALSE** |
| **F-6: catalog failures caught and hidden (L261–262)** | **FALSE** |
| **F-7: never blindly replayed (L270–271)** | **FALSE** |
| F-4: durable state cannot name predecessors (L236–238) | PARTIAL |
| Limitations: "absence claims are avoided where output was limited" (L311–312) | contradicted by the three above |

**Omission:** the Rust core is never mentioned (no "Rust", "harness-core", top-level `core/`, "cargo"); the execution
architecture describes only the TypeScript tree.

## d88a897 facts

| Fact | Ground truth at 25208c1 | Artifact |
|---|---|---|
| TS CLI launches the Rust core | tools.ts:14–17 resolves `core/target/{release,debug}/harness-core`; tools.ts:209 `spawn(...)` | **no claim** (neither stated nor contradicted) |
| tracked files 1,118–1,120 | `git ls-files \| wc -l` = **1120** | **no claim** |

## Severity

F-1 premise false (reuse, not duplication) — at most LOW. F-2 false. F-3 mechanism true, consequence overstated;
severity inconsistent (MEDIUM vs HIGH in the final report). F-4 partly supported. F-5 race real, staleness logic
misdescribed; LOW appropriate. F-6 mostly unsupported. F-7 interpretation false. F-8 supported.

## Not verified

`npm test` 768/128 at 25208c1 (not rerun, to keep the workspace untouched); an mtime-reordering write path (F-3);
whether automatic-path provenance is persisted in reconstructable form (F-4); this run's context/admission counters.

## Verdict — **NOT ACCEPTED** against context exit criterion 6

- Met: artifact produced; authoritative verifier passes (21/21, reproduced).
- **Not met:** three false absence claims (F-2, F-6, F-7).
- **Not shown:** the d88a897 facts — the artifact omits the Rust core and the tracked-file count. Better than d88a897
  and R2 (where the Rust-core claim was false), but not a demonstration.
- Further errors: wrong file for `runSubagent`; `capacity_fixture.ts` contents fabricated from console output; F-5
  staleness inverted; F-1 premise contradicted by its own evidence; F-6 keyword-hit citations.
- R3 hypothesis: first write at 52 and completion at 108 (R2: write at 103, LIMIT_REACHED) is consistent with it, on
  one run; completing did not make the claims accurate.

Note: the run predates the Stage 7 fixes (8cdc719, fdfd36c). Under fdfd36c a VERIFIED result that rests on output
that left context and was not re-read carries a context qualifier; whether this run would have been qualified needs
the acceptance rerun on the fixed build.
