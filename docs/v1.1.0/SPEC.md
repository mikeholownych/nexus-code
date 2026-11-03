# Nexus Code v1.1.0 implementation specification

Status: normative. Any behaviour change must update this document in the same commit.
Baseline: `origin/main` `c7d0b003` (v1.0.0 + Dependabot). Review: [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md).
Decisions and their evidence: [`DECISIONS.md`](DECISIONS.md). Verification: [`VALIDATION.md`](VALIDATION.md).

Terminology: **MUST**, **MUST NOT**, **SHOULD** are used in the RFC 2119 sense. "v1.0.0 record" means an
operation record written by any released 1.0.0 build, i.e. `operation.schemaVersion === 1`.

---

## 1. Scope

### 1.1 v1.1.0 delivers

1. A versioned, fail-closed `DurableOperationState` schema (version 2) with a tested migration from a v1.0.0 record.
2. Strict operation-spec validation, including a fail-closed error for the not-yet-supported `git.publish`.
3. Bounded, deterministic **parallel execution** of work units over the existing durable operation model.
4. A deterministic **integration queue** so concurrent git-isolated units merge serially into one operation branch,
   with receipts that name the candidate and the executed tests.
5. A persisted, typed **inter-agent message channel** that carries cross-unit summaries, artifact pointers and
   verdicts, delivered as task context. No shared mutable memory.
6. **Read-only replay** of an operation, alongside the existing live view.
7. Completion of the terminal-safety and schema-validation gaps in the existing view.

### 1.2 Explicitly out of scope for v1.1.0

| Out of scope | Reason | Target |
|---|---|---|
| TUI operation pane and in-view decision interaction | Needs the Ratatui surface and a PTY qualification matrix; the CLI view already covers the operator need | v1.2 (DEC-V11-14) |
| `git.publish: "pr"` | Requires an operation-level egress authorization primitive; `git push`/`gh` via a shell bypasses `InformationFlowBoundary` | v1.2 (DEC-V11-12) |
| Semantic retrieval over operation records | Needs a local index lifecycle and an embedding-egress policy; no provider qualification in v1.1 | v1.2 (DEC-V11-13) |
| Hosted/remote multi-tenant execution | Trust boundary is a local operator (v1.1 README ground rules) | not planned |
| Model-authored verifiers / self-approval | Existing gates are unchanged | never |
| Multiple driver processes per operation | One lock, one writer (`operation_runner.ts:404-412`); a lease protocol is a separate design | v1.2+ |
| Automatic test generation from requirement text | Separate research item with its own harness | not planned |
| Changing provider request patterns or the inference transport | Not needed by this scope | — |

### 1.3 Inherited constraints from v1.0.0

These MUST remain true after every v1.1 change. A change that relaxes one is a release-blocking defect.

1. `TurnResult` truthfulness: a unit is `COMPLETE` only through `turnSucceeded(TurnResult)` (`VERIFIED` or
   `NOT_REQUIRED`); `UNVERIFIED` is never complete.
2. Verifier and baseline gates: no unit completes without the evidence the unit model already requires.
3. Candidate identity: integration is recorded, never re-judged; a moved tree fails closed.
4. Durable recovery: every transition is persisted; a crash resumes to the same decision point.
5. Provider failure classification: `resource_unavailable`, `execution_unknown`, `failed` keep their meanings.
6. Terminal safety: all agent- and operation-derived text passes `safeTerminal`.

---

## 2. Architecture

### 2.1 Component map

```
operation_cli.ts ── parse/validate spec ──► newOperation() ──► OperationStore.save()
       │                                                            │
       ├── status --dag / --replay ──► operation_view.ts (projection, read-only)
       │                                                            │
       └── run/resume ──► driveOperation() ── lock ──► OperationRunner.run()
                                                            │
                        ┌───────────────────────────────────┼──────────────────────────┐
                        ▼                                   ▼                          ▼
              ConvergenceScheduler.decide()        Registry (resources)        OperationGit
              (pure; returns a due-set)            select / eligibility        worktrees, integration queue
                        │                                   │                          │
                        └──────────────► batch executor (WP-3) ◄────────────────────────┘
                                             │  per unit: AgentWorkUnitExecutor.run()
                                             ▼
                                       OperationStore.save()  (after every transition)
```

Ownership is unchanged from v1.0.0 except where this document says otherwise:

| Component | Responsibility | MUST NOT |
|---|---|---|
| `ConvergenceScheduler` (`cli/src/core/scheduler.ts`) | Pure decision logic over state: dependency gating, resource selection, due-set ordering, escalation, decision application | Perform I/O, read the clock except through `now()`, execute a unit |
| `OperationRunner` (`cli/src/core/operation_runner.ts`) | Time, execution, persistence, integration, recovery | Decide policy that belongs to the scheduler |
| `OperationGit` (`cli/src/core/operation_git.ts`) | Worktree/branch lifecycle, serialised integration, receipts | Verify the unit's work (it re-runs the unit's verifier only) |
| `ResourceRegistry` (`cli/src/core/resources.ts`) | Eligibility, qualification, condition windows, observations | Know which units are running (the scheduler holds reservations) |
| `OperationView` (`cli/src/operation_view.ts`) | Projection of state for humans and scripts | Write, lock, mutate, or resume |
| `OperationStore` (`cli/src/core/operation_runner_persistence.ts`) | Load/save with schema gate, account migration, per-operation lock | Choose when to save |

### 2.2 Concurrency model (normative)

```
one process ─ one operation lock ─ one scheduler ─ one due-set per iteration
                                                   │
                                    ┌──────────────┴──────────────┐
                                    ▼                             ▼
                               unit A (resource R1)         unit B (resource R2)
                                    │                             │
                                    └──────── completion ─────────┘
                                                   │
                                        integration queue (serial)
                                                   │
                                          OperationGit.integrate()
```

- Exactly one process drives an operation (`driveOperation`). Parallelism is **intra-process only**.
- The scheduler is the only place that decides what runs; the runner only executes what it returns.
- A resource slot is reserved for the duration of a unit's run. Two units MUST NOT hold the same slot when the
  resource's `maxConcurrentUnits` is 1 (the default).
- Unit worktrees are per unit; the integration worktree is shared and therefore integration is serialised.

---

## 3. Parallel scheduling

### 3.1 Decision type

`Decision` has exactly one run form: an ordered batch. A single unit is a batch of length 1, so no caller needs a
special case and there is no second shape to keep in sync.

```ts
export type Decision =
  | { kind: "run"; assignments: Assignment[] }   // length >= 1, deterministic order, no shared single-slot resource
  | { kind: "wait"; wakeAt: number; reason: string; parked: string[] }
  | { kind: "complete" }
  | { kind: "blocked"; decisions: EscalationDecision[] };

export interface Assignment {
  unit: WorkUnit;
  resource: ResourceDescriptor;
  reroutedFrom?: { resourceId: string; reason: string };
}
```

This is a breaking change to the `Decision` type for any direct `ConvergenceScheduler` consumer (the runner and the
tests); it is not a persisted format, so no migration is needed.

Invariants (asserted in tests):

- `assignments.length >= 1` for `kind: "run"`.
- Every `assignment.unit` was `RUNNABLE` and is distinct.
- No two assignments share a resource whose `maxConcurrentUnits` is 1.
- Assignments are in deterministic order (§3.2).

### 3.2 Deterministic ordering

Order is a total order over the runnable set, computed from state + observations only:

1. `required: true` before `required: false`.
2. **Critical path length descending.** The length is the number of unfinished units on the longest dependency chain
   that starts at the candidate, counting only units that are not `COMPLETE` (the same rule the view uses,
   `operation_view.ts:265-304`).
3. The operation's **declared unit order** (the index in `state.units`, which is durable state).

Unit id was considered as the tie-break and rejected: it is equally deterministic, but it would reorder the
independent units of an existing v1.0.0 operation after upgrade for no benefit. `localeCompare` is banned anywhere in
this order because it is locale-dependent.

The same `(state, conditions, now)` MUST produce the same list. The list is truncated to the concurrency limit
(§3.3) *after* reservation-aware selection (§3.4), so truncation never changes which unit is first. Determinism is
asserted by repeating `decide()` over one state (ACC-V11-MAO-04); it is deliberately **not** asserted to be invariant
under reordering the declaration, because declaration order is an input.

### 3.3 Concurrency limit and configuration

| Setting | Type | Default | Where |
|---|---|---|---|
| `policy.maxConcurrentUnits` | integer ≥ 1 | `1` | `OperationPolicy`; overridable per operation in the spec `policy` block |
| `resource.maxConcurrentUnits` | integer ≥ 1 | `1` | `ResourceDescriptor` (new optional field) |

Effective limit = `min(policy.maxConcurrentUnits, count(distinct slots whose resources are qualified and eligible))`.
A limit of 1 MUST reproduce v1.0 behaviour exactly, including the single `run` decision path, so a default
operation is byte-identical to a v1.0.0 run apart from `schemaVersion`.

Validation: a non-integer, `0`, negative, or `> 64` limit is rejected at `newOperation` and at spec load with a
message naming the field and the allowed range. The cap of 64 is a cost bound, not a capacity claim.

### 3.4 Resource reservation

The scheduler selects assignments greedily over the deterministic order:

```
reserved = Map<resourceId, count>          // seeded with the slots already held by RUNNING units
for candidate in orderedRunnable:
    sel = candidate.override ? overrideSelection(candidate) : registry.select(candidate.requires, excludedModels(candidate))
    if !sel.chosen: (park/block as today) continue
    // Preference order: the registry's chosen resource, then the rest of its qualified list in registry order.
    resource = first r in [sel.chosen, ...sel.qualified] where r.eligibility.eligible and reserved[r.id] < (r.maxConcurrentUnits ?? 1)
    if !resource: continue                 // qualified but every slot is busy: stay RUNNABLE
    reserve(resource)
    assignments.push({unit: candidate, resource, reroutedFrom: resource.id === sel.chosen.id ? sel.reroute : undefined})
    if assignments.length === effectiveLimit: break
```

Two details matter:

- **Selection is reservation-aware.** Asking the registry for "the best" resource and then skipping a busy one would
  serialise two units even when a second qualified resource is free. The unit takes its next qualified, eligible
  resource instead.
- **A busy slot is not a condition story.** `reroutedFrom` is recorded only when the assigned resource is the one the
  registry preferred, so a unit displaced to a second resource by a full slot does not emit a misleading
  `WORK_REROUTED` event.

A unit skipped because every qualified slot is busy stays `RUNNABLE` and is considered on the next iteration; it MUST
NOT be parked or blocked. If nothing can start while units are `RUNNING`, `decide()` returns `wait` with the reason
"every runnable unit's qualified resource is busy" — never `blocked`.

`overrideSelection` (operator assignment) is subject to the same reservation rule: an operator-assigned resource
with one slot still runs one unit at a time.

### 3.5 Failure semantics under concurrency

| Event | Required behaviour |
|---|---|
| One unit fails while a batch-mate runs | The failure is applied to that unit only; the batch-mate continues to completion; its conversation and state are untouched |
| `signal` aborts | Abort the shared `AbortSignal` to every in-flight unit; await all; apply `cancelled` to each; then `scheduler.cancel()`; persist once per unit |
| Resource exhaustion | Only units requiring the exhausted slot park; unaffected units continue (`scheduler.decide` re-runs after each completion) |
| Crash with N units `RUNNING` | On load, `reconcileIntegrated()` runs first (integrated units become `COMPLETE` from receipts), then `reconcileInterruptedRuns()` applies to the remainder; each gets `+1 unknownResumes` and returns to `RUNNABLE` or blocks at the budget |
| Duplicate completion | `integrate()` is idempotent and returns `ALREADY_INTEGRATED`; a receipt is never appended twice for one unit |
| Scheduler exception | The batch is abandoned; every unit still `RUNNING` is reconciled by the next `run()`; the operation blocks with `NOT_CONVERGING` |

### 3.6 Verification edges

An operation MAY declare `implementer → tester → reviewer` with `dependsOn` and `role`. No new mechanism is added:

- `role` selects requirements via `roleRequirements` (`roles.ts:96-107`).
- A reviewer unit sets `requires.independentOf` so `excludedModels` (`scheduler.ts:62-64`) forbids a model that any
  named unit used.
- A reviewer's completion is a normal unit completion; its `outcome` is evidence, and the objective ledger still
  decides whether the operation may complete.
- A failing review MUST end the operation `BLOCKED` with a decision, never `COMPLETE`. This is a test obligation
  (ACC-V11-MAO-06), not a code change.

### 3.7 Worked example

```json
{
  "objective": "Add a --dry-run flag",
  "git": { "isolate": true },
  "policy": { "maxConcurrentUnits": 2 },
  "units": [
    { "id": "impl", "role": "implementer", "prompt": "…" },
    { "id": "docs", "role": "implementer", "prompt": "…" },
    { "id": "test", "role": "tester", "dependsOn": ["impl"], "prompt": "…" },
    { "id": "review", "role": "reviewer", "dependsOn": ["impl", "test"], "requires": { "independentOf": ["impl"] } }
  ]
}
```

With two eligible resources, `impl` and `docs` run concurrently because neither depends on the other and they can
be placed on distinct slots. `test` waits for `impl`; `review` waits for both and is excluded from the model `impl`
used. With one resource, the due-set is `[impl]` and behaviour is identical to v1.0.0.

---

## 4. Durable state, schema and migration

### 4.1 Schema version

```ts
export const CURRENT_OPERATION_SCHEMA_VERSION = 2;

export interface DurableOperationState {
  schemaVersion: 2;            // v1.1
  // … all v1 fields unchanged …
  messages?: OperationMessage[];        // NEW (§6.3)
  // policy gains maxConcurrentUnits; resources gain maxConcurrentUnits (both optional in v1 records)
}
```

`CURRENT_OPERATION_SCHEMA_VERSION` lives in `cli/src/core/operation.ts` next to the type. It is distinct from
`CURRENT_STATE_SCHEMA_VERSION` (the envelope, `state_schema.ts:2`), which is unchanged at 2.

### 4.2 Load rules (fail closed)

`OperationStore.load` and `loadForInspection` MUST call `migrateOperationState` after the envelope load:

| Record `schemaVersion` | Behaviour |
|---|---|
| `undefined` or `1` | Migrate in memory (§4.3), log nothing, keep `updatedAt`; persisted on the next normal save |
| `2` | Use as-is; validate invariants (§4.4) |
| any other integer | Throw `UnsupportedOperationSchemaError` naming the record's version and the supported version |
| non-integer / negative | The envelope gate already treats the record as corrupt; the operation gate MUST also reject it rather than assume 1 |

`UnsupportedOperationSchemaError` MUST be a distinct exported class so the CLI can print a one-line message (no
stack) and exit 2, and the view can refuse to render. It MUST NOT quarantine the record: a future-version record is
not corrupt and must remain readable by the build that wrote it.

### 4.3 Migration v1 → v2

The migration is **pure and in-memory**; it adds no fields that are not derivable:

```ts
function migrateOperationState(raw: any): DurableOperationState {
  if (raw?.schemaVersion === CURRENT_OPERATION_SCHEMA_VERSION) return raw;
  if (raw?.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new UnsupportedOperationSchemaError(raw.schemaVersion);
  return {
    ...raw,
    schemaVersion: CURRENT_OPERATION_SCHEMA_VERSION,
    // absent v1.1 fields stay absent; readers already use ?? [] / ?? 1 defaults
  };
}
```

Deliberate choices:

- `messages` is **not** materialised as `[]` by the migration. Leaving it absent keeps a migrated record's hash
  stable until something is written, and every reader uses `state.messages ?? []`.
- `policy.maxConcurrentUnits` is **not** injected. `effectiveConcurrency(state)` returns
  `state.policy.maxConcurrentUnits ?? 1`, so a migrated v1 record schedules exactly as before.
- No unit is rewritten. `contextBudget`, `context`, `git`, `integrations` and `contextCheckpoints` already load
  through defensive defaults (verified: `operation_runner.ts:120,290,351`).

Persistence: the migrated object is saved by the next ordinary `save()` (driver transition, decision, checkpoint).
The envelope migration backup already applies because the envelope version is unchanged; therefore the operation
migration MUST also write a `.pre-migration-v1` copy of the **whole record** before the first v2 write. Reuse
`backupBeforeMigration` semantics (`state.ts:413-447`): create once, never overwrite, verify an existing backup
byte-for-byte, and fail the save if the backup cannot be written.

### 4.4 Invariants validated on load

Cheap structural checks, each with a one-line error naming the field and the unit:

1. `units` is an array; every `id` is a unique non-empty string.
2. Every `dependsOn` names a unit in the record.
3. `contextBudget`, when present, is a positive integer.
4. `policy.maxConcurrentUnits`, when present, is an integer in `[1, 64]`.
5. `messages`, when present, is an array whose entries have `id`, `at`, `from`, `kind`, `to`, `body`.
6. `integrations`, when present, is an array with `unitId` and `integratedCommit`.

A violation is a corrupt record: quarantine it (existing behaviour) rather than proceed with a half-valid state.

### 4.5 Compatibility

- Forward: a **v1.1.0** build refuses a record from a newer build (`UnsupportedOperationSchemaError`). A **v1.0.0**
  binary, however, has no operation-document gate — the gate was added in v1.1.0 — so it will open a v2 record, ignore
  the new fields, and can write it back without them. That is why the pre-migration copy exists and why downgrade is a
  documented restore procedure, not an automatic one: restore `<record>.pre-migration-v1` before running a v1.0.0
  binary against that operation.
- Backward: v2 builds read every v1 record, and the migration is tested against a checked-in v1.0.0 fixture
  (§10, ACC-V11-SCHEMA-02).
- The `--dag --json` view document is version **2** in v1.1 (it was 1). Because the schema uses
  `additionalProperties: false`, adding `replay` is a breaking change for a strict validator, so the version and the
  checked-in schema's `const` are bumped together (`OPERATION_VIEW_SCHEMA_VERSION`).

---

## 5. Git-aware operations

### 5.1 Isolation (unchanged)

`spec.git.isolate` creates an integration worktree/branch and one worktree/branch per unit
(`operation_git.ts:180-229`). Operator-visible guarantees from v1.0.0 are preserved: the operator's checked-out
branch is never moved, a missing worktree fails closed, and a rewound integration branch blocks the operation.

### 5.2 Receipts (extended)

```ts
export interface IntegrationReceipt {
  unitId: string;
  branch: string;
  commit: string;                 // the unit's tip that was merged
  integratedCommit: string;
  mergedAt: string;
  files: string[];
  outcome: string;
  summary: string;
  verification: "PASSED" | "PASSED_POSTHOC" | "NOT_RUN" | "ALREADY_INTEGRATED" | "ALREADY_MERGED" | "NO_CHANGES";
  candidate?: { digest: string; scope: "tree" | "commit" };                    // NEW
  tests?: { command: string; status: string; hasExecutedTests: boolean };      // NEW
  sequence?: number;                                                           // NEW: 1-based merge order
}
```

`candidate.digest` is `computeCandidateIdentitySync(worktree).candidateId` for the unit's worktree at merge time
(`cli/src/core/candidate.ts`); `scope: "commit"` records the merged commit id, `scope: "tree"` the tree digest. `tests`
is copied from `UnitRunResult.completed.verification` when present, and omitted when the unit produced none — an absent
field is honest evidence, a fabricated one is not. `sequence` is monotonic within an operation, assigned by the runner
when the merge queue reaches the unit; it is optional in the type because `OperationGit.integrate` is also callable
outside an operation (tests, direct use), where inventing an order would be false. A runner-produced receipt always
carries it.

### 5.3 Integration queue (new)

Integration is serialised independently of completion order:

- A per-runner promise chain (`integrationQueue`) accepts `integrate(unit, result)` calls and settles them one at a
  time, in **arrival (completion) order**.
- Each completed unit enqueues exactly one integration job. A unit that is not git-isolated needs no job.
- The queue MUST drain before the runner returns on `complete`, `blocked` and `cancel`, so no receipt is lost.
- A queued integration for a unit that was cancelled or dropped before its turn is skipped and logged as
  `INTEGRATION_SKIPPED` in the event log; it MUST NOT merge work from a non-completed unit.
- The receipt's `sequence` is assigned when the merge succeeds, not when it was enqueued.

Determinism note: arrival order is a function of completion timing, which is not deterministic across runs. The
*outcome* (which commits are present) MUST be deterministic for non-overlapping units; the receipt `sequence` is
allowed to differ. Tests assert set equality of receipts, not order, except where one unit depends on another, where
dependency order is guaranteed because the dependent cannot start before the dependency is `COMPLETE`.

### 5.4 Conflict and integration-failure policy (unchanged)

A textual conflict aborts the merge, leaves both branches intact, and parks the unit with `MERGE_CONFLICT` and the
options `retry` (resolve in the workspace) and `revise`, plus the scheduler's terminal stop. There is no automatic
model-driven conflict resolution. A merged tree that fails the unit's verifier is `INTEGRATION_FAILED` and the merge
is reset (`operation_git.ts:353-363`).

### 5.5 Publication (deferred)

`git.publish` is **not** implemented in v1.1.0. Until it is:

- The spec validator MUST reject `git.publish` with exit 2 and a message naming the key and stating that PR
  publication is not available in this version.
- Any other unknown key in `git`, in a unit, or at the top level MUST be rejected the same way (§4.3 of
  ROADMAP-REVIEW). Silent acceptance of a security-relevant key is a defect, not a convenience.

The v1.2 design constraint is recorded so it is not improvised later: publishing is an egress action and MUST go
through an operation-level decision whose action kind is dedicated (`publish_pr`), recorded in
`state.decisions`, with the payload passing `InformationFlowBoundary.evaluateEgress` and a local egress recorder
proving that no request is made without an applied authorization. Shelling out to `gh` from `run_command` is not an
acceptable implementation because it runs under the `exec` effect, not `egress`.

### 5.6 Lifecycle cleanliness

On the normal paths (`complete`, `cancel`), every unit worktree is removed unless it has uncommitted or ignored
files, and the integration worktree is retained because it is the operator's inspection surface. The v1.1
acceptance is therefore stated precisely: **no unit worktree remains after a clean lifecycle**, and every retained
worktree is named in the event log with its reason (`WORKTREE_RETAINED`, detail `{ worktree, reason: "dirty" |
"ignored" }`). The previous "leaves no worktree behind" claim was false.

### 5.7 Documentation corrections

`GIT_AWARE_OPERATIONS.md` MUST be corrected in the same change: conflict options, receipt fields, the integration
queue, the "no worktree" claim, and the stale "what exists today" section that contradicts its own status line.

---

## 6. Context, messages and cross-unit knowledge

### 6.1 Per-unit budget (implemented; one addition)

The pre-inference preflight (`operation_runner_execution.ts:152-187`) stays as is. v1.1 adds the estimate source so
the block decision can name it:

```ts
context?: {
  estimatedPromptTokens: number;
  budgetTokens: number;
  contextLimit: number;
  at: string;
  source: "agent-estimate" | "operator-budget";   // NEW: which bound decided, and where the number came from
};
```

`source` is `"operator-budget"` when `budgetTokens < contextLimit`, else `"agent-estimate"`. The `CONTEXT_BUDGET`
question MUST name the bound, the estimate and this source. The budget remains a **start-of-turn lower bound**; it
does not bound mid-turn growth, and that limitation stays documented.

### 6.2 Semantic retrieval (deferred)

Not in v1.1.0. The reason is not effort: retrieval that returns operation content must be local, opt-in, and must
never become verification evidence. That requires a local index over unit conversations with its own lifecycle,
deletion semantics (a compacted or deleted item must be reported as such, never fabricated), and a rule for
embedding egress. None of that exists, and inventing it inside a scheduling release would put an unqualified data
path next to the verification gates. Target v1.2 with its own evaluation.

### 6.3 Inter-agent channel (new)

#### 6.3.1 Model

```ts
export type OperationMessageKind = "request" | "observation" | "artifact" | "verdict";

export interface OperationMessage {
  id: string;                 // "msg-<n>" monotonic within the operation
  at: string;                 // ISO
  from: string;               // unit id, or "operator"
  to: string;                 // unit id, or "*" for the operation
  kind: OperationMessageKind;
  /** Bounded, human-readable body. Control characters are rejected, not stripped, at write time. */
  body: string;               // <= 4_000 chars
  /** Pointers the recipient can read itself: receipts, files, conversation ids. Never content. */
  refs?: Array<{ kind: "file" | "receipt" | "unit" | "checkpoint"; ref: string }>;
  /** Set when a unit's prompt included this message; a message is delivered at most once. */
  deliveredAt?: string;
  deliveredTo?: string;
}
```

Bounds: at most **200** retained messages per operation; on overflow the oldest `deliveredAt` messages are dropped
first, and if every message is undelivered the oldest is dropped with an `OPERATION_MESSAGE_DROPPED` event. This
mirrors the event ring (`scheduler.ts:24,54`) and keeps a long operation's record bounded.

#### 6.3.2 Producers

| Producer | Message |
|---|---|
| Unit completion | `artifact` from the unit to `"*"`: its verified summary, plus `refs` to the integration receipt (when git-isolated) and the unit id. Emitted by the runner after `scheduler.apply` succeeds, never before, so an unverified unit publishes nothing. |
| Reviewer verdict | `verdict` from the reviewer to `"*"` when `role === "reviewer"` and the unit completes: `body` is the outcome plus summary |
| Operator | `nexus operation message <op> --from operator --to <unit|\*> --kind <kind> --body <text>` |
| Unit (deferred) | A `send_unit_message` tool. Deferred because it adds a tool surface and an approval-policy effect class; the channel is useful without it, and adding it later is additive. |

#### 6.3.3 Delivery

- When the runner builds `UnitRunContext`, it passes `messages: OperationMessage[]` = undelivered messages addressed
  to this unit or to `"*"` (excluding the unit's own), oldest first, capped at 20 per turn.
- Those messages are marked `deliveredAt`/`deliveredTo` in the same `save()` that records the unit's `RUNNING`
  transition, so a crash cannot deliver twice.
- The prompt renders them under a fixed heading (`Messages from other units (advisory; read the referenced artifact
  before relying on it):`) with the sender, kind, body and pointers. Control characters are impossible here because
  `publishMessage` rejects them at write time, so the prompt is safe by construction rather than by sanitising agent
  content (which would corrupt it). Anything that renders a message to a **terminal** goes through `safeTerminal`. On a
  **resume**, the undelivered set is re-rendered; a message already delivered is not repeated.
- A message is advisory context. It is never verification evidence and MUST NOT change `TurnResult`, the verifier,
  or an independence decision.

#### 6.3.4 Cross-unit summaries (CTX-3)

The existing dependency summary injection (`operation_runner_execution.ts:491-500`) stays, and the channel replaces
the need for a second mechanism:

- A unit's `artifact` message is the operator-visible publication of its summary.
- A downstream unit receives (a) exactly the declared dependency summaries, and (b) any undelivered messages
  addressed to it or to `"*"`. Nothing else.
- The acceptance is exact: a dependent unit's prompt MUST contain exactly the declared dependencies' summaries, and
  MUST NOT contain a non-dependency's summary unless an explicit message was published.

### 6.4 Checkpoints (unchanged)

`nexus operation checkpoint|checkpoints|restore` keep their v1.0.0 semantics: hash-checked bundle, pre-restore
backup, operation lock held across the write, fail-closed resume, path-safe names. v1.1 adds one test: restoring a
checkpoint and resuming MUST produce a turn with the documented verification consequence (fail closed, then
re-verify), which v1.0.0 asserted only in prose.

---

## 7. Observability

### 7.1 Live view (unchanged surface)

`nexus operation status [id] --dag [--json] [--events N]` and `nexus operation watch [id] [--interval S] [--events N]`
keep their v1.0.0 contract: read-only, scheduler-derived eligibility, bounded watch, sanitised text, no lock, no
operation transition.

### 7.2 Replay (new)

`nexus operation status [id] --replay [--json] [--events N]` renders a finished **or** in-progress operation as a
chronological timeline. It is the same projection, not a second model.

Rules:

- Replay reads the persisted `events` array and the unit/decision records. It MUST NOT re-execute, re-load a
  provider, or write.
- Ordering is by `at` ascending, then by original array index for equal timestamps (stable, not `sort()`-unstable).
- Each row carries a monotonically increasing `index` starting at 1, the wall-clock time, the event type, the unit
  or resource it concerns, and the sanitised message. A decision row includes the applied option label and note.
- `--json` emits the same array of views as `--dag --json`, plus a `replay` object per view:
  ```json
  { "schemaVersion": 1, "entries": [ { "index": 1, "at": "…", "type": "WORK_STARTED", "unitId": "impl", "message": "…" } ] }
  ```
- The view schema is bumped to 2 and gains `replay` with `additionalProperties: false`.
- `--dag` and `--replay` are mutually exclusive; passing both exits 2 with a message.
- Replay of an operation with no events renders an explicit "no recorded events" line, not an empty screen.

### 7.3 TUI pane (deferred)

Not in v1.1.0. The CLI view is the supported surface; a pane would need its own PTY qualification and would couple
the scheduler release to the Rust TUI. Target v1.2 (DEC-V11-14).

### 7.4 In-view decisions (deferred)

The view prints the exact mutation command (`operation_view.ts:453`). Persisting a decision from inside the view
would create a second mutation path into `applyOperatorDecision`; the single command surface is the safer design
until the TUI pane exists.

### 7.5 Events added in v1.1

| Event | When | Detail |
|---|---|---|
| `WORK_STARTED` (existing) | per unit, at assignment | unchanged |
| `WORK_COMPLETED` (existing) | per unit, after apply | unchanged |
| `INTEGRATION_QUEUED` | a unit's integration enqueued | `{ unitId }` |
| `INTEGRATION_SKIPPED` | queued integration skipped (unit cancelled/dropped) | `{ unitId, detail: { reason } }` |
| `WORK_INTEGRATED` | a completed unit's branch was merged | `{ unitId, detail: { integration: receipt } }` |
| `WORKTREE_RETAINED` | disposal kept a worktree | `{ unitId, detail: { worktree, reason } }` |
| `OPERATION_MESSAGE` | a message was published | `{ unitId: from, detail: { to, kind, id } }` — body is **not** logged |
| `OPERATION_MESSAGE_DROPPED` | ring overflow dropped an undelivered message | `{ unitId: from, detail: { id, to, kind } }` |
| `CONCURRENCY_LIMIT` | the due-set was truncated by the limit | `{ detail: { limit, eligible } }`; emitted once per distinct truncation, not per `decide()` call |

Event bodies never include message content or provider output. `MAX_EVENTS` stays 300.

### 7.6 Terminal safety (completed)

Every rendered string passes `safeTerminal`, including `view.status` and `unit.status` (`operation_view.ts:500,528`),
plus the new replay `type` and `unitId`. The view-schema test validator MUST implement the keywords the schema uses:
`$ref`, `type`, `required`, `properties`, `additionalProperties`, `items`, `const`, `enum`, `minimum`, `maximum`,
`pattern`, `maxLength`, `minItems`. A schema keyword the validator does not implement is a test failure, not a
silent pass.

---

## 8. Security boundaries

| Boundary | Rule | Change in v1.1 |
|---|---|---|
| Operation spec input | Untrusted operator file. Validate structurally; reject unknown keys; never `eval`; never interpolate a value into a shell command | Stricter (new) |
| Provider text → terminal | `safeTerminal` on every rendered field | Completed |
| Message channel | Bodies are agent-authored; reject control characters at write time; render through `safeTerminal`; never execute a body | New |
| Git refs and paths | Existing slug/path-safety rules (`operation_git.ts:43-46`) | Unchanged |
| Worktree isolation | A concurrent write unit never shares a worktree with another unit | Newly enforced under concurrency |
| Egress | No new network path. `git.publish` remains absent | Unchanged (deliberately) |
| State store | Per-operation lock + global guard; durable atomic writes; quarantine on corruption | Unchanged |
| Secret handling | Message bodies and events are redacted by the existing store redaction on save; the channel adds no secret-bearing field | Unchanged |

A message body that contains a credential-shaped string is stored redacted by the existing save-time redaction; the
sender's unit conversation is not rewritten. This is the same rule as any other agent output.

---

## 9. Configuration

### 9.1 Operation policy

```json
{ "policy": { "maxConcurrentUnits": 2, "maxWaitMs": 43200000, "maxRunsPerUnit": 25 } }
```

`mergeOperationPolicy` (`operation_cli.ts`) already merges config + spec. The new key follows the same precedence:
spec overrides config overrides default 1. An invalid value is rejected before any worktree is created.

### 9.2 Resource slots

```json
{ "resources": [ { "id": "primary", "endpoint": "…", "model": "…", "maxConcurrentUnits": 2 } ] }
```

Defaults to 1. A resource that advertises capacity through provider discovery MAY map a discovered concurrent
request allowance onto this field; v1.1 does not do so automatically (a discovered number is an observation, not a
guarantee).

### 9.3 Operator commands added

| Command | Purpose |
|---|---|
| `nexus operation message <op> --from operator --to <unit\|*> --kind <k> --body <text>` | Publish a typed message |
| `nexus operation status <op> --replay [--json]` | Replay the recorded timeline |

Both hold the operation lock only for the write (`message`) and never for the read (`status`).

---

## 10. Acceptance criteria

Each criterion is executable and names its evidence. `VALIDATION.md` maps them to commands.

### 10.1 Schema and compatibility

| ID | Criterion |
|---|---|
| ACC-V11-SCHEMA-01 | Loading a checked-in v1.0.0 operation record produces a `schemaVersion: 2` state that is otherwise deep-equal to the input, and the first save writes a `.pre-migration-v1` backup byte-identical to the original |
| ACC-V11-SCHEMA-02 | After migration, `decide()` on the migrated state returns the same assignments as on the pre-migration state for a fixture with two units, one resource |
| ACC-V11-SCHEMA-03 | A record with `schemaVersion: 3` throws `UnsupportedOperationSchemaError` from both `load` and `loadForInspection`, is **not** quarantined, and the CLI exits 2 with no stack trace |
| ACC-V11-SCHEMA-04 | A v2 record with `contextBudget: 0` or `maxConcurrentUnits: 0` is rejected as corrupt and quarantined |

### 10.2 Spec validation

| ID | Criterion |
|---|---|
| ACC-V11-SPEC-01 | A spec containing `git.publish` exits 2, names `publish`, and creates no operation record and no worktree |
| ACC-V11-SPEC-02 | A spec containing an unknown top-level key or unknown unit key exits 2 and names the key |

### 10.3 Concurrency

| ID | Criterion |
|---|---|
| ACC-V11-MAO-01 | Two independent units on two single-slot resources run concurrently: both are `RUNNING` before either completes, and the event log contains two `WORK_STARTED` rows before the first `WORK_COMPLETED` |
| ACC-V11-MAO-02 | The same two units with `maxConcurrentUnits: 1` are strictly serialised: exactly one `RUNNING` at any time |
| ACC-V11-MAO-03 | Running the same fixture sequentially and with concurrency 2 yields the same set of unit outcomes, summaries and integration receipts |
| ACC-V11-MAO-04 | One thousand `decide()` calls over the same state return the same due-set, and the order matches required-first → critical-path-desc → declared-order |
| ACC-V11-MAO-05 | A message published by unit A is present in unit B's `UnitRunContext.messages` exactly once, is marked delivered in the saved state, and is absent from a second turn's context |
| ACC-V11-MAO-06 | `implementer → tester → reviewer` with a failing review ends the operation `BLOCKED` with a decision and never `COMPLETE` |
| ACC-V11-MAO-07 | Killing the runner with two units `RUNNING` and resuming leaves both resumable, with `unknownResumes` incremented once each and no duplicated tool result |
| ACC-V11-MAO-08 | Cancelling a two-unit batch aborts both, records both as `cancelled`, preserves both conversations, and leaves both resumable |
| ACC-V11-MAO-09 | Two units whose only qualified resource is the same single-slot resource serialise; the second starts only after the first completes |
| ACC-V11-MAO-10 | With no `maxConcurrentUnits` configured, a state never has two units `RUNNING` simultaneously |

### 10.4 Git integration

| ID | Criterion |
|---|---|
| ACC-V11-GIT-01 | Two isolated units that complete in the same iteration both merge into the operation branch, with distinct `sequence` values and both commits reachable from its tip |
| ACC-V11-GIT-02 | A crash between enqueue and merge resumes and integrates once; the receipt count for that unit is exactly 1 |
| ACC-V11-GIT-03 | Every receipt for a unit that produced verification evidence carries `candidate.digest` and `tests` matching the unit result |
| ACC-V11-GIT-04 | A cancelled unit's queued integration is skipped, logged as `INTEGRATION_SKIPPED`, and its branch is not merged |
| ACC-V11-GIT-05 | After a clean complete/cancel lifecycle, no unit worktree remains and every retained worktree is named in the event log with a reason |

### 10.5 Context

| ID | Criterion |
|---|---|
| ACC-V11-CTX-01 | A `CONTEXT_BUDGET` block's question names the binding bound, the estimate and `source`; `unit.context.source` is `"operator-budget"` when the cap binds and `"agent-estimate"` otherwise |
| ACC-V11-CTX-02 | A dependent unit's prompt contains exactly the summaries of its declared dependencies and no other unit's summary |
| ACC-V11-CTX-03 | An operator `request` message to unit B appears in B's next turn and in no other unit's turn |
| ACC-V11-CTX-04 | Restoring a context checkpoint and resuming produces a turn whose verification consequence is fail-closed (the restored turn is not treated as verified) |

### 10.6 Observability

| ID | Criterion |
|---|---|
| ACC-V11-OBS-01 | `--replay` renders every persisted event exactly once, in ascending `at` order, with contiguous indices from 1 |
| ACC-V11-OBS-02 | `--replay --json` validates against `operation-view.schema.json` version 2 |
| ACC-V11-OBS-03 | `--replay` leaves the record byte-identical (sha256 + mtime) |
| ACC-V11-OBS-04 | `--dag --replay` exits 2 and writes nothing |
| ACC-V11-OBS-05 | A hostile `status`/`type` value in a tampered record renders as visible control pictures, never as an escape sequence |

### 10.7 Non-regression

| ID | Criterion |
|---|---|
| ACC-V11-REG-01 | The full CLI suite and the Rust suite pass at the candidate commit |
| ACC-V11-REG-02 | Every v1.0.0 operation test that passes before the change passes after it, unchanged |
| ACC-V11-REG-03 | A default (concurrency 1) operation produces the same outcomes and the same set of events as v1.0.0; event ordering may differ only where two units are independent, and the deterministic order is declared in §3.2 |
| ACC-V11-REG-04 | `check_requirements.mjs --enforce` passes with the v1.1 rows added |
| ACC-V11-REG-05 | `sync-version.mjs --check` passes at the candidate version |

---

## 11. Performance requirements

These are bounds, not targets; they are measured in the focused tests, not in CI timing.

| Requirement | Bound | Method |
|---|---|---|
| Scheduler decision cost | O(U·(U+E)) with U units, E dependency edges; 200 units, 400 edges < 50 ms | Pure function benchmark in a test |
| Concurrency overhead | A 2-unit batch on a 50 ms mock executor completes in < 200 ms wall clock | Fake clock, real timers disabled |
| Message delivery | 200 retained messages scanned per turn < 5 ms | Unit test |
| Replay | 300 events render in < 100 ms at 120 columns | Pure render, no I/O |
| State size | A 20-unit, 200-message operation record < 2 MiB | Fixture assertion |

Parallelism MUST NOT multiply provider cost silently: the default is 1, and the effective limit is logged in the
`CONCURRENCY_LIMIT` event when a due-set is truncated.

---

## 12. User experience

### 12.1 What the operator sees

- `nexus operation status --dag` shows the DAG, statuses, attempts, resources with ineligibility reasons, the open
  decision and its exact command — unchanged.
- When concurrency > 1, the view shows every `RUNNING` unit with its resource, so two concurrent units are visibly
  concurrent rather than looking like a stuck DAG.
- `nexus operation status --replay` shows a timeline: `1. 10:02:11 WORK_STARTED impl — Implementer started on primary`.
- A message publication appears in `--dag`'s event list as `OPERATION_MESSAGE` with sender and recipient, never the
  body, so a long body cannot flood the view.
- `nexus operation message` prints the message id and the operation status, nothing else.

### 12.2 Error text

Every new error is one line, sanitised, and names the field and the remedy. The CLI prints the message without a
prefix and exits 2 for a spec the operator must fix:

- `git.publish is not supported in this version; remove it to start the operation.`
- `unknown unit 'impl' key 'depends' (did you mean 'dependsOn'?)`
- `operation record schema 3 is newer than this build supports (2); upgrade Nexus to open it`
- `policy.maxConcurrentUnits must be an integer from 1 to 64 (got 0)`

### 12.3 Empty and degraded states

- Replay with no events prints `No events were recorded for this operation.`
- A batch truncated by the limit emits one `CONCURRENCY_LIMIT` event per iteration, not per unit, so the log stays
  readable.
- A message ring overflow is visible as one `OPERATION_MESSAGE_DROPPED` event naming what was dropped.

---

## 13. Traceability

The item → spec → work package → acceptance mapping lives in [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §4 and is
mirrored into `docs/v1.1.0/REQUIREMENTS.md` so `check_requirements.mjs` can enforce it.
