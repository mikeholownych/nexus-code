# PA-3 durable goal lifecycle

This slice adds `/goal` as a durable objective lifecycle over `TeamOrchestrator`, `OperationStore`, and the existing
`ObjectiveLedger`. It does not add another scheduler or workflow store. The original objective and its requirement
ledger live in the operation's existing durable task record; operation transitions preserve that ledger. Work-unit
ledgers remain attached to their own durable tasks and contribute only requirement evidence for the same immutable
objective.

## Commands

```text
/goal <objective>
/goal status [id]
/goal list
/goal show <id>
/goal pause [id]
/goal resume [id]
/goal cancel [id]
/goal requirements [id]
/goal requirements descope <goal-id> <requirement-id> <reason>
/goal requirements accept <goal-id> <requirement-id>
/goal evidence [id]
```

Omitting an id selects the only active goal, or the only goal in the workspace. Multiple eligible goals require an
explicit id. Scope reduction records a reason first and requires a separate operator acceptance command, using the
existing objective-ledger `applyRequirementUpdates` and `acceptDescoping` rules.

## Acceptance and recovery

A goal is `COMPLETE` only when its durable operation completed, the independent reviewer produced an accepted verdict
on a model distinct from the implementer, deterministic verification passed with executed tests, and the parent
objective ledger has no open or unaccepted requirements. Review depends on the tester unit so it sees the candidate
after verification. Missing evidence, a failed review, or an unresolved hard requirement remains `BLOCKED`.

Pause and cancellation refuse to overwrite a running unit. The operator resumes first so the operation runner can
reconcile any unknown effect. A cancelled goal is terminal. The existing operation/task store persists the graph,
work-unit task ids, objective ledger and receipts.

A goal with previously started work left `RUNNING` or `WAITING` by an earlier driver is surfaced as `PAUSED` with a
visible reason on the next load/resume path. A new plan with no unit execution can start without a redundant pause,
and an operation already `BLOCKED` at an operator decision remains at that decision boundary. When the operator
chooses to continue, the decision command records its current process as the new driver before resuming; a later
process death is still detected. Driver identity is recorded in durable operation metadata (`activeBootId`,
`activePid`, `activeHost`). Same-host process death and host-boot changes are detected; a live lock holder is never
treated as stale. Resume is explicit; the stale-driver pause is cleared only when the operator resumes and the
operation is driven again.

The command handler is shared by the REPL and sidecar router; the TUI receives it from the sidecar catalogue. The REPL
marks status/list/show/requirements/evidence as read-only inspection and keeps execution, pause, resume, cancel and
scope changes unavailable in read-only mode.

## Current limits

- Goal decomposition currently reuses the existing full team graph; arbitrary requirement-to-work-unit mapping is not
  exposed by `/goal`. Use `/batch` when an operator needs an authored work-unit DAG.
- Token usage roll-up is reported in goal results and `/goal` output (agent runs, total/reported/estimated tokens,
  inference requests). The report marks the total as incomplete when any child task usage is unavailable. When
  `operation.policy.maxTotalTokens` is set, the driver pauses the goal at a safe boundary before starting new work
  once rolled-up child task token totals reach the cap. Missing or corrupt accounting also pauses the goal, because
  the cap cannot be enforced from a partial sum; the pause reason identifies unavailable usage. Resume continues
  after the operator repairs the record, raises or removes the cap, or cancels. This is a safe-boundary limit: one
  already-running batch can consume more than the configured cap before the next check.
- PA-3 stall counting is fingerprint-based at operation unit execution: consecutive failures with the same fingerprint count toward `policy.maxStallsPerFingerprint` (default 3), not raw turn count. A stall blocks the unit with `NOT_CONVERGING`. `retry` preserves the fingerprint count; `revise`, `replace`, `set_inputs`, `lift_context_budget`, and `assign` clear it. Operation schema v7 stores this policy/state; v6 records migrate by adding only the schema version, and older binaries refuse v7 records.
- Full PA-3 acceptance qualification remains open (stale-goal pause, verifier-receipt completion, token budget, and fingerprint-stall behavior need end-to-end qualification). `/team` remains experimental until PA-1 and PA-2 are complete.
- Restart-specific interrupted-effect reconciliation beyond stale-boot pause still requires qualification.
- No inference-provider or homelab-ai changes are required. Provider-neutral end-to-end qualification remains separate.

## Reference coding

XERJ returned the opencode goal-state pattern of bounded rounds and a server boot identity at
`packages/schema/src/goal.ts:11`, plus restart-pausing behavior in `packages/core/src/plugin/goal.ts:339`. These informed
the recovery questions only; no peer code was copied. XERJ marked the corpus as incompletely indexed, so absence of a
result is not evidence that no other pattern exists. The stale-boot pause implementation follows Nexus's existing
boot-id pattern (`cli/src/upgrade_journal.ts` / `currentUpgradeBootId`) and durable operation pause semantics. A
follow-up search for fail-closed aggregate token accounting timed out with a partial, irrelevant passage set; it did
not establish a peer pattern, so no further code was borrowed.
