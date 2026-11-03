# v1.1.0 multi-agent collaboration plan

Status: normative for how v1.1.0 work is partitioned and integrated. Rules of engagement remain
`docs/v1.0.0/CONCURRENCY.md`; this document adds the v1.1 work packages, contracts, and integration order.

Lead: `v11-lead` (branch `v1/v11-lead-program`, worktree `/home/mike/nexus-wt/v11-lead`).
Spec: [`SPEC.md`](SPEC.md). Traceability: [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §4.

---

## 1. Ownership model

- **One lead agent** is accountable for architecture, contracts, integration, traceability and release readiness.
  The lead owns this plan and `SPEC.md`; a behaviour change without a spec update is incomplete.
- **Work packages (WPs)** are the unit of delegation. A WP is bounded, independently useful, and has one owner.
- **File boundaries** are exclusive. Two agents never edit the same file in parallel; a shared file is serialised
  through a hot-file claim (CONCURRENCY §4) and the lead schedules it.
- **Contracts** (§3) are frozen before implementation. An agent that needs a contract change stops and requests it
  from the lead; it does not improvise a second shape.

## 2. Work packages

| WP | Title | Owner (role) | Depends on | Parallel-safe with | Files owned |
|---|---|---|---|---|---|
| WP-1 | Schema v2, migration, spec validation, terminal safety | Agent A | — | WP-5, WP-7 | `cli/src/core/operation.ts`, `cli/src/core/operation_schema.ts` (new), `cli/src/operation_cli.ts`, `cli/src/operation_view.ts`, `cli/test/operation_schema.test.ts` (new), `cli/test/operation_view.test.ts`, `docs/v1.1.0/operation-view.schema.json` |
| WP-2 | Scheduler due-set, determinism, resource reservation | Agent B | WP-1 contract only | WP-5, WP-7 | `cli/src/core/scheduler.ts`, `cli/src/core/operation.ts` (types section only, after WP-1 lands), `cli/test/v11_scheduler_concurrency.test.ts` (new) |
| WP-3 | Runner batch execution, integration queue, cancellation, recovery, receipts | Agent C | WP-1, WP-2 | WP-7 | `cli/src/core/operation_runner.ts`, `cli/src/core/operation_git.ts`, `cli/src/core/operation_runner_execution.ts`, `cli/test/v11_runner_concurrency.test.ts` (new), `cli/test/operation_git.test.ts` |
| WP-4 | Inter-agent channel: model, delivery, CLI, summary publication | Agent D | WP-1 (types), WP-3 (delivery hook) | WP-5, WP-7 | `cli/src/core/operation_messages.ts` (new), `cli/src/core/operation_runner_execution.ts` (delivery only), `cli/src/operation_cli.ts` (message command only), `cli/test/v11_messages.test.ts` (new) |
| WP-5 | Operation replay | Agent E | WP-1 (view schema) | WP-2, WP-4, WP-7 | `cli/src/operation_view.ts` (replay section only), `cli/src/operation_cli.ts` (`--replay` only), `cli/test/operation_view.test.ts` (replay cases) |
| WP-6 | Requirements ledger and traceability enforcement | Agent F | WP-1..WP-5 acceptance IDs | none | `docs/v1.1.0/REQUIREMENTS.md` (new), `scripts/check_requirements.mjs` (v1.1 ledger support only) |
| WP-7 | Documentation, release notes, changelog, release-process fixes | Agent G | WP-1..WP-5 | WP-2..WP-5 | `docs/v1.1.0/*.md`, `CHANGELOG.md`, `docs/releases/v1.1.0*.md`, `docs/releases/PROTECTIONS.md`, `README.md` |
| WP-8 | PR publication (deferred) | unassigned | — | — | `docs/v1.1.0/SPEC.md` §5.5 only until v1.2 |
| WP-9 | TUI pane / semantic retrieval (deferred) | unassigned | — | — | — |

### 2.1 Why this order

1. **WP-1 first.** Everything else reads `DurableOperationState`. If the schema gate and migration land after the
   scheduler, the scheduler's tests would encode a shape that later changes, and the migration test would have to be
   rewritten. WP-1 also repairs two defects (D-V11-01, D-V11-02) that are independent of concurrency and would
   otherwise be buried in a large diff.
2. **WP-2 before WP-3.** The scheduler is pure and cheap to test exhaustively; the runner is I/O and expensive. A
   due-set bug found in WP-2 costs minutes; the same bug inside the runner costs a flaky suite.
3. **WP-3 before WP-4.** Message delivery happens at the same `save()` as the `RUNNING` transition. That hook lives
   in the runner, so the runner must be stable first.
4. **WP-5 is independent** of concurrency and can run in parallel from the moment WP-1's view schema bumps.
5. **WP-6 and WP-7 last** so they record what actually shipped, not what was planned.

## 3. Frozen contracts

These are the only shapes agents share. Changing one requires a lead decision recorded in
[`DECISIONS.md`](DECISIONS.md).

### 3.1 `Decision.run` batch form

```ts
export interface Assignment { unit: WorkUnit; resource: ResourceDescriptor; reroutedFrom?: Reroute }
export type Decision =
  | { kind: "run"; assignments: Assignment[] }     // length >= 1, deterministic order, no shared single-slot resource
  | { kind: "wait"; wakeAt: number; reason: string; parked: string[] }
  | { kind: "complete" }
  | { kind: "blocked"; decisions: EscalationDecision[] };
```

Owner: WP-2. Consumer: WP-3. WP-3 MUST accept a batch of length 1 and MUST NOT special-case `length === 1`.

### 3.2 Operation schema version

```ts
export const CURRENT_OPERATION_SCHEMA_VERSION = 2;
export function migrateOperationState(raw: unknown): DurableOperationState;  // throws UnsupportedOperationSchemaError
export function effectiveConcurrency(state: DurableOperationState): number;  // policy.maxConcurrentUnits ?? 1
```

Owner: WP-1. Consumers: WP-2 (`effectiveConcurrency`), WP-3, WP-4, WP-5, the view.

### 3.3 Message model

```ts
export type OperationMessageKind = "request" | "observation" | "artifact" | "verdict";
export interface OperationMessage { id; at; from; to; kind; body; refs?; deliveredAt?; deliveredTo? }
export function publishMessage(state, msg: Omit<OperationMessage,"id"|"at">, now: number): OperationMessage;
export function undeliveredFor(state, unitId: string): OperationMessage[];   // <= 20, oldest first
export function markDelivered(state, ids: string[], unitId: string, at: string): void;
```

Owner: WP-4. Consumer: WP-3 (calls `undeliveredFor`/`markDelivered` in the save that starts a unit).

### 3.4 Receipt extension

```ts
candidate?: { digest: string; scope: "tree" | "commit" };
tests?: { command: string; status: string; hasExecutedTests: boolean };
sequence: number;
```

Owner: WP-3. Consumer: WP-4 (`refs` to a receipt), WP-5 (nothing — replay reads events only).

### 3.5 View document

`schemaVersion` becomes `2`; adds `replay?: { schemaVersion: 1; entries: ReplayEntry[] }`; `additionalProperties:
false` everywhere. Owner: WP-1 (bump) and WP-5 (contents). Any other agent adding a view field must coordinate with
both.

## 4. File and hot-file discipline

Per CONCURRENCY §2, claims are directories under `$(git rev-parse --git-common-dir)/nexus-claims/`.

| File | WPs | Rule |
|---|---|---|
| `cli/src/core/operation.ts` | WP-1, WP-2, WP-4 | Serialised. WP-1 first (schema/version), then WP-2 (Decision/Assignment), then WP-4 (message fields). Each change is a separate commit. |
| `cli/src/core/scheduler.ts` | WP-2 only | Exclusive claim. |
| `cli/src/core/operation_runner.ts` | WP-3 only | Exclusive claim. |
| `cli/src/core/operation_runner_execution.ts` | WP-3, WP-4 | WP-3 lands first; WP-4 adds only the message-delivery block and the prompt heading, in a separate commit. |
| `cli/src/operation_cli.ts` | WP-1, WP-4, WP-5 | One agent at a time; each adds a distinct command/flag block. |
| `cli/src/operation_view.ts` | WP-1, WP-5 | WP-1 (sanitisation + schema bump), then WP-5 (replay). |
| `docs/v1.1.0/operation-view.schema.json` | WP-1, WP-5 | WP-1 bumps the version; WP-5 adds `replay`. |
| `cli/test/operation_view.test.ts` | WP-1, WP-5 | Serialised; append-only per WP. |
| `CHANGELOG.md`, `docs/releases/*` | WP-7 only | Exclusive. |

Every agent runs `git rev-parse HEAD` and `git log <mine>..HEAD` before each commit and stops on a foreign commit
(CONCURRENCY §5.1).

## 5. Integration order and checkpoints

| Checkpoint | Entry | Exit criteria | Review |
|---|---|---|---|
| CP-0 | Baseline recorded | `origin/main` sha, v1.0 gate status, claims reconciled (this document + ROADMAP-REVIEW §1) | Lead |
| CP-1 | WP-1 merged into `v1/v11-lead-program` | Schema/migration/spec/safety tests green; no other test changed behaviour | Lead + independent reviewer |
| CP-2 | WP-2 merged | Scheduler property tests green (1,000 shuffles); concurrency 1 byte-identical outcomes | Lead + independent reviewer |
| CP-3 | WP-3 merged | Batch execution, queue, cancellation, crash-resume tests green; full CLI suite green | Lead + independent reviewer |
| CP-4 | WP-4 merged | Channel tests green; dependent-unit prompt exactness | Lead |
| CP-5 | WP-5 merged | Replay tests green; view schema v2 validates | Lead |
| CP-6 | WP-6 + WP-7 merged | `check_requirements --enforce` green with v1.1 rows; docs accurate | Lead + independent reviewer |
| CP-7 | RC qualification | `VALIDATION.md` gates G1–G4 executed on the exact commit | Independent acceptance |

A checkpoint is not "tests passed". It is "the WP's acceptance IDs are demonstrated with named evidence, the diff
was reviewed by someone other than its author, and no other WP's acceptance regressed".

## 6. Assignment briefs

Each brief below is complete enough to hand to a fresh agent with no conversation history. The lead fills in
`<commit>` and `<WP>` when delegating.

### 6.1 WP-1 — Schema v2, migration, spec validation, terminal safety

**Objective.** Make `DurableOperationState` versioned and fail closed, reject unknown spec keys, and complete
terminal safety in the operation view.

**In scope.** `CURRENT_OPERATION_SCHEMA_VERSION = 2`; `migrateOperationState`; `UnsupportedOperationSchemaError`;
load-time invariants; `.pre-migration-v1` backup of the whole record before the first v2 write; strict spec
validation for top level, `policy`, `git`, and each unit; `safeTerminal` on `view.status`/`unit.status`; the view
schema validator keyword completion.

**Explicitly out of scope.** Any scheduler or runner change; the `Decision` type; message fields; replay; the
`git.publish` implementation (it must be rejected, not built).

**Spec.** §4.1–§4.5, §7.6, §12.2. **Acceptance.** ACC-V11-SCHEMA-01..04, ACC-V11-SPEC-01/02, ACC-V11-SAFE-01/02.

**Owned files.** As in §2 WP-1. **Do not touch** `scheduler.ts`, `operation_runner*.ts`, `docs/v1.0.0/**`.

**Deliverables.**
1. `cli/src/core/operation_schema.ts` with the constant, the migration, the invariant checker and the error class.
2. `cli/test/operation_schema.test.ts` with a checked-in v1.0.0 fixture (`cli/test/fixtures/operation-v1.json`) that
   is a real record captured from a v1.0.0 run, not hand-written to fit the migration.
3. Spec-validation tests using a temporary JSON file and the real CLI entry point.
4. A hostile-record test injecting `\x1b]52;…\x07` into `unit.status` and asserting no ESC in `--dag` output.
5. `operation-view.schema.json` version 2 with a validator that fails on an unimplemented keyword.

**Checks.**
```
node scripts/run_tests.mjs test/operation_schema.test.ts test/operation_view.test.ts
node scripts/run_tests.mjs test/operation_git.test.ts test/convergence_scheduling.test.ts   # non-regression
npx tsc --noEmit -p cli
```

**Handoff format.** A commit on a `v1/wp1-*` branch, a report listing changed files, the commands run and their
exit codes, acceptance IDs demonstrated with the test name that proves each, and any acceptance ID not demonstrated
with the reason. Open risks go in the report, not in a comment.

**Blockers.** If the v1.0.0 fixture cannot be produced without running an inference provider, stop and ask the lead;
synthesise from the documented v1 shape instead and mark the fixture `synthetic-documented` in the test name.

### 6.2 WP-2 — Scheduler due-set, determinism, reservation

**Objective.** Turn `decide()` from "the next unit" into "the ordered due-set", with resource reservation and a
configurable limit that defaults to 1.

**In scope.** `Assignment`; `run` with `assignments`; `effectiveConcurrency`; the total order in SPEC §3.2;
reservation in SPEC §3.4; `CONCURRENCY_LIMIT` event; validation of the limit in `newOperation`.

**Out of scope.** Executing anything, persisting, git, messages, the view.

**Spec.** §3.1–§3.4, §3.6–§3.7, §10.3 (scheduler-side IDs). **Acceptance.** ACC-V11-MAO-01 (scheduler half),
ACC-V11-MAO-04, ACC-V11-MAO-09 (scheduler half), ACC-V11-MAO-10.

**Owned files.** `cli/src/core/scheduler.ts`, the `Decision`/`Assignment`/policy section of
`cli/src/core/operation.ts`, `cli/test/v11_scheduler_concurrency.test.ts`.

**Deliverables.** The implementation, a property test that shuffles unit order 1,000 times and asserts an identical
due-set, and a focused test proving a single-slot resource is never assigned twice in one batch.

**Checks.** `node scripts/run_tests.mjs test/v11_scheduler_concurrency.test.ts test/convergence_scheduler_properties.test.ts test/convergence_scheduling.test.ts test/team_convergence.test.ts` and `npx tsc --noEmit -p cli`.

**Handoff format.** As WP-1. Additionally: paste the due-set for the SPEC §3.7 example under concurrency 1 and 2.

**Blockers.** The critical-path helper currently lives in `operation_view.ts` and importing it into the scheduler
would invert the dependency (view already imports operation). Implement the length function in the scheduler and
have the view keep its display version; a divergence between them is a test failure, not a shared helper.

### 6.3 WP-3 — Runner batch execution, integration queue, cancellation, recovery

**Objective.** Execute a due-set concurrently, serialise integration, cancel and recover correctly, and extend
receipts.

**In scope.** Batch loop; per-unit `scheduler.start`/`apply`/`save`; integration queue; `INTEGRATION_QUEUED`/
`INTEGRATION_SKIPPED`; receipt `candidate`/`tests`/`sequence`; cancellation of all in-flight; restart reconciliation
order (`reconcileIntegrated` before `reconcileInterruptedRuns`); worktree cleanliness assertion.

**Out of scope.** Scheduling policy; schema; messages; replay.

**Spec.** §2.2, §3.5, §5.2–§5.4, §5.6, §10.3 (runner IDs), §10.4. **Acceptance.** ACC-V11-MAO-01..03,
ACC-V11-MAO-07/08/09 (runner half), ACC-V11-GIT-01..05.

**Owned files.** `cli/src/core/operation_runner.ts`, `cli/src/core/operation_git.ts`,
`cli/src/core/operation_runner_execution.ts` (no message block), `cli/test/v11_runner_concurrency.test.ts`,
`cli/test/operation_git.test.ts`.

**Deliverables.** A deterministic fake executor (per-unit gates) and tests for: two-to-two concurrency, serialisation
on one slot, cancel-both, crash-resume-both, queued-integration-once, skipped integration for a cancelled unit,
clean lifecycle. Each test names the acceptance ID in its `test(...)` title.

**Checks.** `node scripts/run_tests.mjs test/v11_runner_concurrency.test.ts test/operation_git.test.ts test/convergence_scheduling.test.ts test/operation_view.test.ts` plus `npx tsc --noEmit -p cli`. Then the full suite at CP-3.

**Handoff format.** As WP-1, plus a table of "transition → what is persisted → when" for the batch path, so the
reviewer can check the durability claim without reading the whole runner.

**Blockers.** If a per-unit `save()` inside a batch can interleave with another unit's `save()` and corrupt state,
stop: the store is not designed for interleaved writers. The intended resolution is that all writes are synchronous
and ordered by the single event loop; prove it in a test rather than assuming it.

### 6.4 WP-4 — Inter-agent channel

**Objective.** Persist typed messages, publish artifacts/verdicts automatically, deliver undelivered messages to the
next turn, and expose an operator command.

**In scope.** `operation_messages.ts`; `state.messages`; publication on completion (artifact) and on reviewer
completion (verdict); `UnitRunContext.messages`; delivery marking in the start `save()`; the `operation message`
command; ring pruning; `OPERATION_MESSAGE`/`OPERATION_MESSAGE_DROPPED` events.

**Out of scope.** A `send_unit_message` agent tool (deferred); semantic retrieval; changing dependency-summary
injection.

**Spec.** §6.3. **Acceptance.** ACC-V11-MAO-05, ACC-V11-CTX-02/03.

**Owned files.** `cli/src/core/operation_messages.ts`, `cli/src/core/operation_runner_execution.ts` (delivery block
only), `cli/src/operation_cli.ts` (message command only), `cli/test/v11_messages.test.ts`.

**Deliverables.** Unit tests for publish/deliver/prune/redact; a prompt-rendering test asserting the fixed heading
and sanitisation; a CLI test using the real store.

**Checks.** `node scripts/run_tests.mjs test/v11_messages.test.ts test/context_management.test.ts test/operation_view.test.ts` and `npx tsc --noEmit -p cli`.

**Handoff format.** As WP-1, plus the exact prompt fragment produced for a unit with one dependency summary and one
operator request.

**Blockers.** If delivery cannot be made idempotent without a second write, stop and ask the lead: at-most-once
delivery is an acceptance criterion, not a nicety.

### 6.5 WP-5 — Replay

**Objective.** Render the recorded timeline read-only, in human and JSON form.

**In scope.** `--replay`; mutually exclusive with `--dag`; chronological stable ordering; contiguous indices; the
`replay` view field; schema v2; empty-state line.

**Out of scope.** Re-execution, provider calls, TUI, decisions.

**Spec.** §7.2, §7.5, §12.3. **Acceptance.** ACC-V11-OBS-01..05.

**Owned files.** `cli/src/operation_view.ts` (replay section), `cli/src/operation_cli.ts` (`--replay`),
`cli/test/operation_view.test.ts` (replay cases), `docs/v1.1.0/operation-view.schema.json` (`replay`).

**Deliverables.** Replay renderer, JSON projection, purity test (byte-identical record), mutual-exclusion test,
schema test, empty-operation test.

**Checks.** `node scripts/run_tests.mjs test/operation_view.test.ts` and `npx tsc --noEmit -p cli`.

### 6.6 WP-6 — Requirements ledger

**Objective.** Make v1.1 acceptance enforceable.

**In scope.** `docs/v1.1.0/REQUIREMENTS.md` with one row per acceptance ID: ID, statement, spec section, plan
reference, test reference (`test:<file>::"<exact test name>"`), status, evidence. Extending
`check_requirements.mjs` to read the v1.1 ledger when `--ledger docs/v1.1.0/REQUIREMENTS.md` is passed, without
changing the v1.0 ledger behaviour.

**Out of scope.** Changing any v1.0 row; changing thresholds.

**Deliverables.** The ledger and `node scripts/check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md
--enforce` passing, with a deliberate-failure test proving a missing test reference fails the gate.

### 6.7 WP-7 — Documentation and release process

**Objective.** Make every claim in the docs true and prepare the release artifacts.

**In scope.** Correct the four proposals (status lines, stale "what exists today", overstated options/receipts/
worktree/queue/test-count claims); `CHANGELOG.md` v1.1.0 section; `docs/releases/v1.1.0.md`; fix
`docs/releases/PROTECTIONS.md` required-context list; record the `cli/dist` CI no-op as a known gap; update
`README.md` only where a user-visible command changed.

**Out of scope.** Version bumping (lead does it at RC time); release publication.

**Deliverables.** Docs diff plus a claim-by-claim table: claim, source line, verified reality, new text.

### 6.8 Deferred briefs

- **WP-8 (PR publication).** Not delegated in v1.1.0. Preconditions before it can start: an operation-level
  `publish_pr` decision action, an egress authorization record in `state.decisions`, an egress recorder in the test
  harness, and a decision that the operation record may carry repository content off the machine.
- **WP-9 (TUI pane, semantic retrieval).** Not delegated in v1.1.0. Preconditions: a PTY qualification matrix for the
  pane; a local-index lifecycle with deletion semantics for retrieval.

## 7. Review responsibilities

| Review | Reviewer | Must check |
|---|---|---|
| WP-1 | Not its author | The migration is against a real v1.0.0 shape; no field is silently invented; unknown spec keys fail closed; no test weakened |
| WP-2 | Not its author | Determinism is proven by shuffling; reservation cannot double-assign; concurrency 1 is the v1.0 path |
| WP-3 | Not its author | Every transition is persisted before the next await; integration is serial; cancel leaves state resumable; receipts are honest |
| WP-4 | Lead | At-most-once delivery; body bounds; no content in events; prompt fragment exact |
| WP-5 | Lead | Purity (byte-identical); stable ordering; schema conformance |
| WP-6 | Lead | Every acceptance ID maps to a test that exists and passes |
| WP-7 | Lead | Every corrected claim is re-verified against source, not against the previous doc |

An independent reviewer MUST NOT be the implementing agent (CONCURRENCY §8). The reviewer records the exact diff
sha256 and an ACCEPT/CHANGES_REQUIRED disposition. A review that only reads the summary is not a review.

## 8. Conflict resolution

- Two WPs needing the same file: the lead serialises by integration order (§5), not by whoever started first.
- Two valid designs: the lead decides against the spec's stated constraints and records the choice in
  `DECISIONS.md` with the rejected alternative.
- A WP discovers a spec error: stop, report, lead updates the spec, WP resumes against the new text.
- A WP discovers a defect outside its boundary: report it, do not fix it silently; the lead creates a bounded WP.

## 9. Status and resumption

`docs/v1.1.0/STATUS.md` is the durable state of the programme: current gate, WP states, commit refs, evidence paths,
open risks, next action. It is updated at every checkpoint so a new lead can resume without this conversation. It is
the single source of truth for "where are we", and it must never claim a state that the evidence does not support.
