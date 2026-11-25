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

A goal whose driver is not provably alive resumes `PAUSED` with a visible reason; nothing runs until the operator resumes it.

Driver identity is recorded in durable operation metadata as `activePid`, `activeHost`, `activeStartTicks` (the kernel start time, field 22 of `/proc/<pid>/stat`) and `activeBootId`. A goal is "actively driven" only when all four are present and name a live process of this host whose start time equals the recorded one. Anything else is stale, and the pause reason says which:

| Cause | Meaning |
| --- | --- |
| process gone | the recorded pid is not running |
| pid recycled | the pid is alive but its start time differs: another process holds it now |
| other host | the record names a different host; its processes cannot be checked from here |
| other boot | the boot id differs: the host rebooted |
| identity unknown | a field is missing, malformed or unverifiable (a record from before `activeStartTicks`, a hand edit, a platform without `/proc`) |

The same rule (`core/driver_identity.ts`) runs on the read path (`/goal status|list|show`, `nexus operation status`, `--dag`, which show `PAUSED` and the reason without writing anything) and on the drive path (`driveOperation` persists the pause and runs no unit). The only exemption is a plan that no one ever started: no identity at all, every unit waiting with zero runs. An operation `BLOCKED` at an operator decision stays at that decision. When the operator applies a decision, the command records its own process as the new driver before resuming; a later death of that process is detected.

Compatibility: the state schema stays at v7. `activeStartTicks` is an optional additive field; a record written by the previous build has none and reads as unknown identity, so an interrupted goal from an older build pauses once and resumes after the operator's explicit resume. Separately, the driver lock (`<id>.lock`, which holds its own start ticks) keeps two live processes from driving one operation, and a read-only command run while another process drives reports "Driven by pid N" instead of failing with the lock error. Identity comes from `/proc`, so on a platform without it an interrupted goal always pauses.

An operation paused by the operator keeps `pauseReason`; if a record also has a stale driver, both reasons are shown.

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
  the cap cannot be enforced from a partial sum; the pause reason identifies unavailable usage. The cap comes from
  `NEXUS_OPERATION_MAX_TOTAL_TOKENS` when the plan is made and is changed afterwards with
  `nexus operation budget <id> --max-total-tokens <n|none>`: an operator command that takes the driver lock, writes
  an `OPERATION_BUDGET_CHANGED` journal event (who, when, old, new) and applies from the next dispatch; it does not
  resume a paused goal. Nothing marks a process as agent-spawned, so the command cannot refuse an agent that shells out
  (see Integrity). The cap is checked before every dispatch against rolled-up child totals. The bound is not exact: one
  dispatched batch (up to `maxConcurrentUnits` units) can pass the cap, and each unit's agent run is not cut off
  mid-run, so the overshoot is the usage of the units in flight when the check last passed.
- PA-3 stall counting is fingerprint-based at operation unit execution (computed over the redacted failure text, the form that is persisted, so a reason containing a secret-shaped string stalls like any other): consecutive failures with the same fingerprint count toward `policy.maxStallsPerFingerprint` (default 3), not raw turn count. A stall blocks the unit with `NOT_CONVERGING`. `retry` preserves the fingerprint count; `revise`, `replace`, `set_inputs`, `lift_context_budget`, and `assign` clear it. Operation schema v7 stores this policy/state; v6 records migrate by adding only the schema version, and older binaries refuse v7 records. `activeStartTicks` is additive within v7.
- Deterministic PA-3 acceptance is recorded in `PA3_ACCEPTANCE.md` (stale pause, token budget, fingerprint stalls, verifier-receipt gates). Restart interrupted-effect reconciliation and live-gateway qualification remain open. `/team` and `nexus operation` no longer carry the experimental label: PA-1 (#787) and PA-2 (#785/#788/#790) are recorded as landed.
- Restart-specific interrupted-effect reconciliation beyond the stale-driver pause still requires qualification.

## Integrity of goal state

Goal state, caps and stall counts live in `<state dir>/tasks/<id>.json` (`NEXUS_STATE_DIR` or `~/.nexus`), mode 0600. Integrity rests on that file mode and on three refusals; it is not signed.

What holds:
- The agent's **file tools** (read, write, edit, delete, batch read) refuse the directory under both its configured and its real-path spelling (a symlinked `$HOME`), and refuse a hard link to a state file (device and inode compared). The advisory command check (`isCommandBlocked`) does **not** look at it.
- Under **`--sandbox`** (bwrap) the real task-state directory is masked, for commands and for the sandboxed worker, whether the workspace is elsewhere, is `$HOME`, or contains it. A sandboxed command can neither read nor write it. Docker mounts only the workspace, so it needs no mask unless the workspace itself contains the state directory.
- A hand-edited record is loaded fail-closed: a malformed field is refused and an incomplete driver identity pauses the goal. A careful, internally consistent edit is accepted.

What does not hold: a command the agent runs **without `--sandbox`** runs with the operator's rights and can rewrite goal state, including caps, stall counts and driver identity, and can run `nexus operation budget`. Use `--sandbox` for untrusted work. No signature scheme is added.

A record naming another live process as its driver is refused by `driveOperation` even when its lock file is gone; a zombie driver counts as gone. Unattended job and loop resumes override the stale pause (issue #807); `/goal resume` does not.

## Reference coding

XERJ returned the opencode goal-state pattern of bounded rounds and a server boot identity at
`packages/schema/src/goal.ts:11`, plus restart-pausing behavior in `packages/core/src/plugin/goal.ts:339`. These informed
the recovery questions only; no peer code was copied. XERJ marked the corpus as incompletely indexed, so absence of a
result is not evidence that no other pattern exists. The stale-boot pause implementation follows Nexus's existing
boot-id pattern (`cli/src/upgrade_journal.ts` / `currentUpgradeBootId`) and durable operation pause semantics. A
follow-up search for fail-closed aggregate token accounting timed out with a partial, irrelevant passage set; it did
not establish a peer pattern, so no further code was borrowed.
