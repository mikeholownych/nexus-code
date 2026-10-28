# v1.1 proposal: operation observability

Status: slice 1 implemented (`v1/feature-operation-view`); TUI pane, replay and in-view decisions remain proposed.
Owner: unclaimed. Depends on: nothing. Size: medium (2–3 weeks).

## What exists today

- `OperationEvent` records with timestamps and messages are emitted by `ConvergenceScheduler` and the runner
  (`cli/src/core/operation.ts`, `cli/src/core/operation_runner*.ts`) and persisted with the operation.
- `nexus operation status [id] [--json]` prints the operation, each unit's status, its parked/blocked reason, and the
  escalation decision (`cli/src/operation_cli.ts`).
- The TUI and the sidecar render agent turns, tool activity and saved diffs, but not an operation: there is no live DAG,
  no resource view, no decision prompt bound to the operation, and no replay.
- `OperationStore` keeps operation state and unit conversations on disk; the events are enough to reconstruct history.

## What to build

1. **A read-only operation view** (`nexus operation status --dag`, `nexus operation watch [id]`, and later a pane in the
   TUI) that renders:
   - the work-unit DAG with dependencies, statuses, attempts, and the current critical path;
   - the resource registry with eligibility, capacity/quota observations, and the reason each resource is ineligible;
   - a streaming event log grouped by unit and turn, with the escalation decision at the top when one is open.
2. **A machine-readable snapshot** (`nexus operation status --json --dag`) with a stable schema for scripts and the
   sidecar, generated from the same model as the human view.
3. **Decision interaction** in the view: choose an escalation option with a note and persist it through the same
   `applyOperatorDecision` path the CLI uses. No new decision semantics. (Slice 1 prints the exact `nexus operation
   decide` command instead; the watch path stays strictly read-only.)
4. **Replay** of a finished operation from its event log and unit conversations (read-only, no re-execution).

What slice 1 already ships is recorded in
`docs/reviews/evidence/v1.1/OPERATION-VIEW-20261028/README.md`: the view model, human and JSON rendering, the critical
path, resource eligibility from the scheduler's own rules, and the bounded watch loop.

## Design constraints

- The view reads only the operation store and the event stream. It must not drive, mutate, or resume an operation;
  mutations continue to go through the command surface.
- No scheduler or state change. If a field is missing for the view (for example a resource's last observation time),
  add it to `OperationEvent` with a default that old records can read.
- Rendering must be safe for very large conversations: read unit conversations lazily, page events, and never hold every
  turn in memory.
- The view must be honest about what it cannot know: an in-flight turn with no event yet is shown as in flight, not as a
  status guess.

## Acceptance

- A recorded operation (the v1.0.0 E2 lifecycle fixture is enough) renders the DAG, resources and events, and
  `--json` output validates against the checked-in `operation-view.schema.json`.
- Killing and restarting the view mid-operation loses nothing: it resumes from the store.
- A decision taken in the view is byte-identical in the store to one taken with `nexus operation decide`.
- The view path writes no operation transition: it never takes the operation lock and a current-schema record is
  byte-identical after `status --dag` and `watch` (asserted by sha256 + mtime). The shared state loader may still migrate
  a legacy record (with its `.pre-migration-*` backup) or quarantine a corrupt one (`.corrupt-*`), exactly as `status`
  does; the view does not add a write path of its own.
- Operation text is rendered through the same terminal sanitiser as agent output (`safeTerminal`), so a provider error
  echoed into a block reason cannot emit control or OSC sequences.

## Qualification impact

None on the release evidence: read-only and additive. Re-run the packaging smoke only.

## Risks

- Scope creep into a scheduler rewrite. Keep the view a projection; refuse any change that needs scheduler cooperation.
- Terminal rendering differences across the E2 platforms; cover the view in the existing PTY drivers rather than a new
  harness.
