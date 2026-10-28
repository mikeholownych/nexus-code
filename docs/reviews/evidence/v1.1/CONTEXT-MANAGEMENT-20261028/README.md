# Context management (v1.1 slice 3): implementation evidence

| | |
|---|---|
| Base | `b2ae2fe8` (`origin/main`) |
| Branch | `v1/feature-context-management` |
| Surface | `units[].contextBudget` in the operation spec; `nexus operation checkpoint|checkpoints|restore` |
| Scope | Per-unit context budget with a pre-inference decision; durable conversation checkpoints. Semantic retrieval and cross-unit summaries remain proposed. |

## Per-unit context budget

`units[].contextBudget` (tokens) is an operator cap below the resource's advertised capacity. Before every turn (RED and
GREEN in a TDD unit) the executor asks the agent for its own admission estimate for that prompt — the same messages,
tool definitions, completion reserve and tool-response reserve as the conversation so far — and records
`unit.context = { estimatedPromptTokens, budgetTokens, contextLimit, at }`. The estimate is a lower bound: the turn
adds the tool groups its prompt enables, runtime context and any freshly pinned requirement ledger.

If the prompt fits the resource but not the unit budget, the unit fails before inference with `CONTEXT_BUDGET`, names the
prompt tokens and the completion/tool reserves that exceed the budget, offers `revise`, and sets `offerReassign` so the
scheduler adds its "assign to another resource" options. If the prompt does not fit the resource at all, or the budget is at or above the resource capacity,
resource-limit pressure stays with the agent's normal admission/compaction path (which can compact and continue), so the
preflight never pre-empts it. The estimate is a start-of-turn lower bound: the turn adds the tool groups its prompt
enables, runtime context and, for a fresh objective, the pinned requirement ledger. The cap therefore gates the start
prompt; mid-turn growth is bounded by the resource limit, not by the unit budget.

## Context checkpoints

`nexus operation checkpoint <op> <unit> [--name <name>]` snapshots a settled (not running, not complete) unit's durable
task-state file byte for byte
(0600, fsync) under `<task store>/context-checkpoints/<operation>/`, and records `{unitId, name, at, taskId, messages,
bytes, sha256}` on the operation. `checkpoints` lists them; `restore` verifies the file's hash, copies it back, keeps the
pre-restore file under `context-checkpoints/<operation>/backups/` (not beside the live task files, where it would appear
as a duplicate task and be retention-eligible), makes the unit runnable, clears this unit's block/park/result and only
this unit's escalation, and prints the resume command. Both commands hold the operation lock for the whole
read-modify-write and refuse with exit 2 when a driver is running the operation.

Restoring is fail-closed: the agent's recovery path treats the resumed task as unverified, so the conversation comes
back but the old verification standing does not. Names must match `[A-Za-z0-9._-]{1,64}` (so no path traversal); a
running or complete unit, a dropped unit, an operation that is COMPLETE/CANCELLED, a missing conversation, unreadable
task state, a tampered checkpoint and unknown names are refused.

## View and schema

`status --dag` and `--json` project `contextBudget`, the last `context` estimate (rendered against the smaller of the
budget and the resource limit), and the operation's checkpoints; the checked-in schema was extended and the schema test
covers the new fields.

## Tests

`cli/test/context_management.test.ts` (12 cases):

1. a unit budget below the resource capacity blocks before inference, records the estimate, offers reassignment and only
   `revise`; no turn runs;
2. a prompt that fits the budget runs and records the estimate;
3. a budget at/above the resource capacity leaves resource pressure to admission (the turn runs);
4. no budget means no preflight and no recorded estimate;
5. a real agent's estimate grows with the prompt, uses its configured limit, and refuses a prompt over the limit;
6. checkpoint copies the conversation (0600) and restore brings it back with a backup, runnable unit and cleared block;
7. traversal names, running units, missing conversations, missing files and unknown checkpoints are refused;
8. a prompt over the resource limit is left to admission even with a budget set;
9. a unit budget must be a positive integer;
10. tampered checkpoints and COMPLETE/CANCELLED operations, complete or dropped units are refused;
11. restoring one unit keeps an operation-level decision (for example the git guard) intact;
12. the CLI creates/lists/restores a checkpoint, rejects a traversal name and refuses with exit 2 while a driver holds
    the operation lock.

Focused run (`context_management`, `operation_view`, `operation_git`, `tdd_work_units`, `convergence_scheduling`,
`operation_runner_refactor`, `operation_account_identity`): **132/132 pass**; `tsc --noEmit` and `git diff --check`
clean, isolated HOME/XDG.

## Residuals / not in this slice

- **Semantic retrieval over the operation record is not implemented.** There is no index, no embedding provider, and no
  retrieval tool; `read_archive`/`read_findings` remain the only recall paths.
- **Cross-unit context sharing is unchanged**: downstream units receive their dependencies' titles and summaries (the
  existing `UnitRunContext.dependencies`), not files, receipts or pointers.
- The preflight is a client-side estimate, not a provider count; it can differ from the provider's tokenizer. It only
  decides when a unit budget is the binding limit.
- A checkpoint captures the conversation, not the workspace. Restoring after workspace changes can leave the
  conversation referring to stale files; the resume is fail-closed for verification but the agent is not told which
  files moved.
- Checkpoints are not garbage-collected and are kept in the task store; removing them is an operator action. There is
  no retention policy and no size cap. A completed unit cannot be checkpointed (and a checkpoint cannot be restored
  after its unit completes), because restoring would re-run work whose integration receipt already exists.
- Checkpoint/restore hold the operation lock and refuse a RUNNING unit, so a live driver is excluded; the remaining
  race is a turn that starts after the lock is released but before the next resume, which the RUNNABLE state makes
  explicit.
- `contextBudget` is per unit only; there is no operation-level or policy default, and no automatic sizing from task
  complexity.
