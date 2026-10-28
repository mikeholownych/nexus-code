# Context management (v1.1 slice 3): implementation evidence

| | |
|---|---|
| Base | `b2ae2fe8` (`origin/main`) |
| Branch | `v1/feature-context-management` |
| Surface | `units[].contextBudget` in the operation spec; `nexus operation checkpoint|checkpoints|restore` |
| Scope | Per-unit context budget with a pre-inference decision; durable conversation checkpoints. Semantic retrieval and cross-unit summaries remain proposed. |

## Per-unit context budget

`units[].contextBudget` (tokens) is an operator cap below the resource's advertised capacity. Before every turn (RED and
GREEN in a TDD unit) the executor asks the agent for its own admission estimate for that exact prompt — the same
messages, tool definitions, completion reserve and tool-response reserve the next request will use — and records
`unit.context = { estimatedPromptTokens, budgetTokens, contextLimit, at }`.

If the prompt fits the resource but not the unit budget, the unit fails before inference with `CONTEXT_BUDGET`, names the
estimate and the budget, offers `revise`, and sets `offerReassign` so the scheduler adds its "assign to another
resource" options. If the budget is at or above the resource capacity, resource-limit pressure stays with the agent's
normal admission/compaction path (which can compact and continue), so the preflight never duplicates or pre-empts it.

## Context checkpoints

`nexus operation checkpoint <op> <unit> [--name <name>]` snapshots the unit's durable task-state file byte for byte
(0600, fsync) under `<task store>/context-checkpoints/<operation>/`, and records `{unitId, name, at, taskId, messages,
bytes}` on the operation. `checkpoints` lists them; `restore` copies one back, keeping the pre-restore file as
`<task>.before-restore-<ms>.json`, makes the unit runnable, clears its block/park/result and the operation block, and
prints the resume command.

Restoring is fail-closed: the agent's recovery path treats the resumed task as unverified, so the conversation comes
back but the old verification standing does not. Names must match `[A-Za-z0-9._-]{1,64}` (so no path traversal); a
running unit, a missing conversation, unreadable task state and unknown names are refused.

## View and schema

`status --dag` and `--json` project `contextBudget` and the last `context` estimate per unit; the checked-in schema was
extended and the schema test covers the new fields.

## Tests

`cli/test/context_management.test.ts` (8 cases):

1. a unit budget below the resource capacity blocks before inference, records the estimate, offers reassignment and only
   `revise`; no turn runs;
2. a prompt that fits the budget runs and records the estimate;
3. a budget at/above the resource capacity leaves resource pressure to admission (the turn runs);
4. no budget means no preflight and no recorded estimate;
5. a real agent's estimate grows with the prompt, uses its configured limit, and refuses a prompt over the limit;
6. checkpoint copies the conversation (0600) and restore brings it back with a backup, runnable unit and cleared block;
7. traversal names, running units, missing conversations, missing files and unknown checkpoints are refused;
8. the CLI creates/lists/restores a checkpoint and rejects a traversal name with exit 2.

Focused run (`context_management`, `operation_view`, `operation_git`, `tdd_work_units`, `convergence_scheduling`,
`operation_runner_refactor`, `operation_account_identity`): **128/128 pass**; `tsc --noEmit` and `git diff --check`
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
  no retention policy and no size cap.
- Checkpoint/restore refuse a RUNNING unit, but a turn starting between the status check and the file write is a race;
  operators should not checkpoint an operation that is actively running.
- `contextBudget` is per unit only; there is no operation-level or policy default, and no automatic sizing from task
  complexity.
