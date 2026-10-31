# v1.1 proposal: multi-agent orchestration

Status (reconciled 2026-10-31): items 1, 2 and 5 are implemented; item 3 is implemented as a persisted typed channel
produced by completed units and the operator (a unit-authored `send_unit_message` tool is deferred); item 4 required no
new mechanism and is covered by a test. Residual gaps are listed in [`REQUIREMENTS.md`](REQUIREMENTS.md) §2. Depends
on: git-aware operations, context management, observability. See [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §2.4.

## What exists today

- Historical: `ConvergenceScheduler` modelled work units with `dependsOn` and decided which unit ran next; the runner
  executed **one due unit at a time**, feeding resource observations back and persisting after every transition. v1.1.0
  replaces the single choice with an ordered due-set (see "What to build" item 1).
- Role-specialized durable units exist (`implementer`, `tester`, `reviewer`, read-only roles), and the objective ledger
  gates implementer/tester completion.
- `spawn_subagent` remains in-turn delegation inside one agent turn: it does not create a scheduled unit, and its work
  is not visible to the operation DAG. Concurrency is a scheduler property, not a subagent property.
- Resources are a registry with eligibility, capacity and quota observations. There is no notion of running two units
  concurrently against the same or different resources.

## What to build

1. **Parallel due-set execution** (implemented): `ConvergenceScheduler.decide()` returns `{ kind: "run", assignments }`,
   a deterministic ordered set up to `policy.maxConcurrentUnits` (default 1, bounded at 64) and limited by per-resource
   slots (`resource.maxConcurrentUnits`, default 1). Each assignment runs as its own durable agent task. A unit whose
   qualified slots are all busy stays `RUNNABLE`; it is never parked or blocked for being busy.
2. **Deterministic scheduling** (implemented): required units first, then the longest unfinished dependent chain, then
   the operation's declared unit order. Unit id was considered as the final tie-break and rejected: declaration order is
   equally deterministic and keeps a v1.0.0 operation running its independent units in the same order after upgrade
   (DEC-V11-03). Concurrency does not change outcomes for independent units (`ACC-V11-MAO-03`).
3. **Inter-agent channel** (implemented for completion artifacts, review verdicts and operator messages): persisted,
   typed messages (`request`, `observation`, `artifact`, `verdict`) in `state.messages`, addressed to a unit or `*`,
   delivered at most once in the same save that starts the recipient. No shared mutable memory. A unit-authored message
   tool is deferred to v1.2: it needs a tool surface and an approval effect, and the channel is useful without it.
4. **Role specialization as a first-class pattern** (already expressible, now tested): `role` selects requirements,
   `dependsOn` declares the verification edge, and `requires.independentOf` forces the reviewer onto a model the named
   units did not use (`scheduler.ts`, `excludedModels`). A reviewer reports through the existing evidence gates; a
   failing review ends the operation `BLOCKED`, never `COMPLETE` (`ACC-V11-MAO-06`). No new mechanism was added, because
   a second one would duplicate the objective ledger.
5. **Failure semantics under concurrency** (implemented): the runner settles every unit of a batch independently
   (`Promise.allSettled` + per-unit persistence), one unit's failure does not touch a batch-mate's conversation, cancel
   aborts all in-flight units and leaves each `RUNNABLE`, and resource exhaustion parks only the units that need the
   exhausted slot. Restart reconciles every `RUNNING` unit after receipt reconciliation.

## Design constraints

- The operation record stays the single source of truth. Every concurrent unit's state transition is persisted; a crash
  resumes each unit independently to the same decision point.
- No unit may observe another unit's in-flight workspace. Isolation is the git-aware worktree (or a copy) per concurrent
  write unit; read-only units may share.
- Concurrency is bounded by resources, not by wall-clock ambition: two units pinned to the same single-slot resource
  cannot run together.
- The existing verification gates are unchanged. A reviewer's verdict is evidence with the same independence rules as
  any other verifier output.

## Acceptance

- Two independent units run concurrently against two resources and produce the same results as running them
  sequentially; the event log shows both.
- Two units pinned to one resource serialize, and the second starts only after the first releases it.
- A dependent unit starts only when its dependencies are `COMPLETE`, and its context contains exactly the declared
  dependency summaries.
- Crash during two in-flight units resumes both without duplicated work or lost tool results. (v1.1.0 demonstrates the
  reconciliation path from a persisted two-`RUNNING` state; a real process kill during a live batch is not yet
  demonstrated — `REQUIREMENTS.md` §2.)
- Cancel stops both, and both are resumable.
- Implementer → tester → reviewer with a failing review ends the operation `BLOCKED` with a decision, never `COMPLETE`.
- No operation with concurrency > 1 can produce a `VERIFIED` unit whose evidence fails the v1.0.0 gates (property test
  over recorded evidence).

## Qualification impact

- Largest: re-run the full E2 matrix and lifecycle (scheduler, persistence and recovery all change), the durability
  cells, and the T3/T4 qualification gates in `ACCEPTANCE.md`. The operation document also gains schema version 2, so
  the migration and rollback checks in `VALIDATION.md` §6 are mandatory.
- Provider checks only if the concurrency model changes request patterns in a way the provider evidence covers; record
  the decision either way.

## Risks

- Persistence and recovery are the hardest part: the state schema will change, so a versioned migration from v1.0.0
  operation records is mandatory and must be tested with a real v1.0.0 record.
- Parallel agents can multiply cost and provider load; concurrency must default to 1 and require explicit opt-in.
- Cross-agent verification can become a rubber stamp. Keep the independence rules and make the reviewer's evidence
  subject to the same `isDeliverableBound`/independence checks.
