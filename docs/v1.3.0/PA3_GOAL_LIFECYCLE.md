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
- PA-3 stretch gaps remain to be audited/implemented: stall counting by failure fingerprint (not turn count) at the
  goal/operation semantics level where applicable, optional token budget roll-up/cap enforcement from sub-operations
  (usage roll-up is reported; no cap enforcement yet), and full PA-3 acceptance qualification. `/team` remains
  experimental until PA-1 and PA-2 are complete.
- Restart-specific interrupted-effect reconciliation beyond stale-boot pause still requires qualification.
- No inference-provider or homelab-ai changes are required. Provider-neutral end-to-end qualification remains separate.

## Reference coding

XERJ returned the opencode goal-state pattern of bounded rounds and a server boot identity at
`packages/schema/src/goal.ts:11`, plus restart-pausing behavior in `packages/core/src/plugin/goal.ts:339`. These informed
the recovery questions only; no peer code was copied. XERJ marked the corpus as incompletely indexed, so absence of a
result is not evidence that no other pattern exists. The stale-boot pause implementation follows Nexus's existing
boot-id pattern (`cli/src/upgrade_journal.ts` / `currentUpgradeBootId`) and durable operation pause semantics.
