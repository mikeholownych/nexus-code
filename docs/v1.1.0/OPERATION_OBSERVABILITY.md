# v1.1 proposal: operation observability

Status (reconciled 2026-10-31): the read-only view **and** replay are implemented; the TUI pane and in-view decision
interaction are deferred to v1.2 (DEC-V11-14). See [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §2.1 and
[`REQUIREMENTS.md`](REQUIREMENTS.md) REQ-V-03/REQ-V-10 for the evidence.
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
4. **Replay** of a finished operation from its event log (read-only, no re-execution). Implemented as
   `nexus operation status --replay [--json]`; the timeline is the event log only, not the unit conversations, because
   conversations are large and may be compacted (DEC-V11-10).

What slice 1 shipped is recorded in `docs/reviews/evidence/v1.1/OPERATION-VIEW-20261028/README.md`: the view model,
human and JSON rendering, the critical path, resource eligibility from the scheduler's own rules, and the bounded watch
loop. Replay was added in v1.1.0: `buildReplay`/`renderReplay` in `cli/src/operation_view.ts`, the `--replay` flag in
`cli/src/operation_cli.ts`, and `cli/test/operation_view.test.ts` (34 cases, of which 5 are replay/terminal-safety).
The evidence README's "21 cases" predates those additions.

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
  `--json` output validates against the checked-in `operation-view.schema.json` (now version 2; the test's checker
  enforces the keywords the schema uses, including `minimum`).
- Killing and restarting the view mid-operation loses nothing: it resumes from the store.
- A decision taken in the view is byte-identical in the store to one taken with `nexus operation decide`.
  (Deferred with the in-view decision interaction: v1.1.0 only prints the exact command.)
- The view path writes no operation transition: it never takes the operation lock and a current-schema record is
  byte-identical after `status --dag` and `watch` (asserted by sha256 + mtime). The shared state loader may still migrate
  a legacy record (with its `.pre-migration-*` backup) or quarantine a corrupt one (`.corrupt-*`), exactly as `status`
  does; the view does not add a write path of its own.
- Operation text is rendered through the same terminal sanitiser as agent output (`safeTerminal`), so a provider error
  echoed into a block reason cannot emit control or OSC sequences.

## Qualification impact

Read-only and additive, so no lifecycle or provider re-qualification. v1.1.0 does add a view-schema version bump
(1 → 2) and a new CLI flag: re-run the packaging smoke and the view test suite. TUI/pane qualification is not owed
because the pane is not shipped.

## Risks

- Scope creep into a scheduler rewrite. Keep the view a projection; refuse any change that needs scheduler cooperation.
- Terminal rendering differences across the E2 platforms; cover the view in the existing PTY drivers rather than a new
  harness.
