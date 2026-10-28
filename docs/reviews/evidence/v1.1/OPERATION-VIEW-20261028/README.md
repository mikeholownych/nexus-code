# Operation view (v1.1 slice 1): implementation evidence

| | |
|---|---|
| Base | `ceaf6007` (`origin/main`) |
| Branch | `v1/feature-operation-view` |
| Surface | `nexus operation status --dag [--json] [--events N]`, `nexus operation watch [id] [--interval N]` |
| Scope | Read-only projection: unit DAG, resource eligibility, open decision, event tail. No scheduler or state change. |

## What it does

`buildOperationView(state)` projects a persisted `DurableOperationState` into a stable, versioned document
(`schemaVersion: 1`): unit statuses with dependency depth and the reason each unit is not running, resource eligibility
computed by the same `ResourceRegistry` the scheduler uses, the open decisions with their copy-ready `nexus operation
decide` command, the event tail, and a DAG with edges, a deterministic critical path over unfinished units, missing
dependency ids and cycle ids.

`renderOperationView(view)` is the human form; both are pure functions of the state.

`watchOperation()` re-reads the state on an interval until the operation is terminal or the caller aborts. It only takes
a `load` callback, so it cannot drive, resume or mutate an operation. Transient read failures are reported and retried;
repeated failures stop the watch with `unreadable` instead of pretending the operation vanished.

`nexus operation status --dag` and `nexus operation watch` read through `OperationStore.load`/`list`, which never take the
operation lock and never persist a migration, so an operation another process is driving can be inspected safely. On a
pipe, `watch` renders one snapshot and exits (complete 0, cancelled/aborted 130, otherwise 2) rather than hanging.

## Evidence

`cli/test/operation_view.test.ts` (14 cases):

1. units/depth/durable/result/blocked detail, DAG edges, critical path, decision options and command;
2. resource eligibility from a real condition record, temporary block with `eligibleAt`, recovery after the window;
3. missing dependency and cycle reported, not hidden;
4. event limit and `events: 0`;
5. purity: building and rendering a view leaves the operation deep-equal;
6. renderer output, determinism, width truncation;
7. terminal operation: no critical path, no decisions;
8. watch until terminal, abort during sleep, render cap, repeated read failures, clear-screen behaviour;
9. CLI: `status --dag` and `--dag --json` on a stored operation, byte-for-byte unchanged store file (sha256 + mtime);
10. CLI: `watch` on a pipe renders one snapshot and exits 2 while blocked, store unchanged;
11. CLI: malformed `--events` exits 2 with no stdout.

Focused run: `operation_view` + `convergence_scheduling` + `operation_runner_refactor` + `operation_account_identity`
→ **69/69 pass**; `tsc --noEmit` and `git diff --check` clean, isolated `HOME`/`XDG_CONFIG_HOME`.

`team_convergence`, `convergence_integration` and `convergence_invariants` have 20 failures on this branch **and on a
pristine `origin/main` worktree** (`ceaf6007`, same command); they are pre-existing and not caused by this slice.

## Residuals / not in this slice

- No TUI pane, no replay of finished operations, and no in-view decision prompt. The view prints the exact
  `nexus operation decide …` command instead of mutating from the watch path.
- The view does not guess an in-flight turn: until an event or status is persisted, it shows the persisted status.
- `status --dag` for all operations loads every operation in the workspace; there is no paging.
