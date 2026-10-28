# v1.1 proposal: multi-agent orchestration

Status: proposed. Owner: unclaimed. Depends on: git-aware operations, context management, observability. Size:
large (3–5 weeks).

## What exists today

- `ConvergenceScheduler` models work units with `dependsOn` and decides which unit runs next; the runner executes **one
  due unit at a time**, feeding resource observations back and persisting after every transition.
- Role-specialized durable units exist (`implementer`, `tester`, `reviewer`, read-only roles), and the objective ledger
  gates implementer/tester completion.
- `spawn_subagent` is in-turn delegation inside one agent turn: it does not create a scheduled unit, and its work is not
  visible to the operation DAG.
- Resources are a registry with eligibility, capacity and quota observations. There is no notion of running two units
  concurrently against the same or different resources.

## What to build

1. **Parallel due-set execution**: the scheduler returns a *set* of runnable units (dependencies complete, resources
   eligible) up to the operation's concurrency limit; each runs as its own durable agent task. The limit is operator-set
   and capped by available resources.
2. **Deterministic scheduling**: a fixed tie-break (critical path, then unit id) so the same state and observations
   produce the same choices; concurrency must not change outcomes for independent units.
3. **Inter-agent channel**: persisted, typed messages between units (request, observation, artifact pointer, review
   verdict) stored in the operation record, delivered as part of the recipient's task context on start or resume. No
   shared mutable memory.
4. **Role specialization as a first-class pattern**: an operation may declare a verification edge (implementer → tester →
   reviewer) with the same gates as v1.0.0; a reviewer unit can only report `VERIFIED` through the existing evidence,
   and cross-agent verification is recorded as evidence, not as trust.
5. **Failure semantics under concurrency**: one unit's failure must not corrupt another's durable conversation; cancel
   must stop all in-flight units and leave each resumable; resource exhaustion parks only the units that need the
   exhausted resource.

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
- Crash during two in-flight units resumes both without duplicated work or lost tool results.
- Cancel stops both, and both are resumable.
- Implementer → tester → reviewer with a failing review ends the operation `BLOCKED` with a decision, never `COMPLETE`.
- No operation with concurrency > 1 can produce a `VERIFIED` unit whose evidence fails the v1.0.0 gates (property test
  over recorded evidence).

## Qualification impact

- Largest: re-run the full E2 matrix and lifecycle (scheduler, persistence and recovery all change), the durability cells,
  and the T3/T4 qualification gates in `ACCEPTANCE.md`.
- Provider checks only if the concurrency model changes request patterns in a way the provider evidence covers; record
  the decision either way.

## Risks

- Persistence and recovery are the hardest part: the state schema will change, so a versioned migration from v1.0.0
  operation records is mandatory and must be tested with a real v1.0.0 record.
- Parallel agents can multiply cost and provider load; concurrency must default to 1 and require explicit opt-in.
- Cross-agent verification can become a rubber stamp. Keep the independence rules and make the reviewer's evidence
  subject to the same `isDeliverableBound`/independence checks.
