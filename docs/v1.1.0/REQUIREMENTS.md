# v1.1.0 acceptance ledger

Enforced by `node scripts/check_requirements.mjs --ledger docs/v1.1.0/REQUIREMENTS.md --enforce`.
The checker resolves `ACC-*` ids against the Markdown beside this ledger (and the v1.0.0 package), and requires every
`test:<file>::"<name>"` reference to name an existing test.

Status vocabulary and thresholds are the v1.0.0 ones (`open < partial < implemented < tested < visually-accepted <
product-qualified`). `RR` rows must reach `tested` for the source gate. Nothing here is `product-qualified`: an
installed-RC qualification run is a separate stage (`VALIDATION.md` §8).

Definitions: [`SPEC.md`](SPEC.md) §10. Traceability: [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §4.

## 1. Requirements

Requirement ids use the `REQ-V-NN` form: `V` is the v1.1.0 family, `NN` is the row number. The v1.0.0 family
(`REQ-AGT-…`, `REQ-REL-…`) is not reused or renumbered.

| ID | Class | Status | Requirement | Acceptance | Spec | Plan | Evidence |
|---|---|---|---|---|---|---|---|
| REQ-V-01 | **RR** | tested | The operation document is versioned, migrates from a v1.0.0 record, and fails closed on an unknown version without quarantining the record | ACC-V11-SCHEMA-01, ACC-V11-SCHEMA-02, ACC-V11-SCHEMA-03, ACC-V11-SCHEMA-04 | [SPEC §4](SPEC.md) | [WP-1](COLLABORATION.md) | test:cli/test/operation_schema.test.ts::"the store keeps a byte-identical pre-migration copy before the first v2 write", test:cli/test/operation_schema.test.ts::"the migrated state schedules exactly as the v1 state did", test:cli/test/operation_schema.test.ts::"a record from a newer build is refused, not quarantined", test:cli/test/operation_schema.test.ts::"structural invariants name the field and the unit" |
| REQ-V-02 | **RR** | tested | An operation spec with an unknown key, or with the unsupported `git.publish`, is refused before any work is created | ACC-V11-SPEC-01, ACC-V11-SPEC-02 | [SPEC §4.3](SPEC.md) | [WP-1](COLLABORATION.md) | test:cli/test/operation_schema.test.ts::"the spec validator rejects publish, unknown keys and a bad limit with an actionable message", test:cli/test/operation_schema.test.ts::"the CLI refuses a spec with git.publish before creating an operation" |
| REQ-V-03 | **RR** | tested | Every field the operation view renders is terminal-safe, and the view-schema checker enforces the keywords the schema uses | ACC-V11-SAFE-01, ACC-V11-SAFE-02, ACC-V11-OBS-05 | [SPEC §7.6](SPEC.md) | [WP-1](COLLABORATION.md) | test:cli/test/operation_schema.test.ts::"a tampered status renders as visible control pictures, never as an escape sequence", test:cli/test/operation_view.test.ts::"the schema checker enforces every keyword the schema uses" |
| REQ-V-04 | **RR** | tested | The scheduler returns a deterministic, ordered due-set up to an operator concurrency limit, reserving per-resource slots; concurrency defaults to 1 | ACC-V11-MAO-01, ACC-V11-MAO-02, ACC-V11-MAO-04, ACC-V11-MAO-09, ACC-V11-MAO-10 | [SPEC §3.1–§3.4](SPEC.md) | [WP-2](COLLABORATION.md) | test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-01/10: the due-set is one unit by default and two when the operator opts in", test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-04: the same state always produces the same due-set", test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-09: a single-slot resource is never assigned twice in one batch" |
| REQ-V-05 | **RR** | tested | The runner executes a due-set, isolates failures, cancels every in-flight unit on abort, and reconciles all interrupted units on restart | ACC-V11-MAO-03, ACC-V11-MAO-07, ACC-V11-MAO-08 | [SPEC §3.5](SPEC.md) | [WP-3](COLLABORATION.md) | test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-03: concurrency does not change the outcome of independent units", test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-07: a restart reconciles every unit that was in flight", test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-08: cancelling a batch cancels every in-flight unit and leaves both resumable" |
| REQ-V-06 | **RR** | tested | A failing reviewer unit ends the operation BLOCKED with a decision and never COMPLETE | ACC-V11-MAO-06 | [SPEC §3.6](SPEC.md) | [WP-2](COLLABORATION.md) | test:cli/test/operation_concurrency.test.ts::"ACC-V11-MAO-06: a failing review ends the operation BLOCKED, never COMPLETE" |
| REQ-V-07 | **RR** | tested | Concurrent isolated units integrate serially into the operation branch, with receipts carrying merge order, candidate digest and executed tests, and no unit worktree left behind | ACC-V11-GIT-01, ACC-V11-GIT-03, ACC-V11-GIT-05 | [SPEC §5.2–§5.3, §5.6](SPEC.md) | [WP-3](COLLABORATION.md) | test:cli/test/operation_concurrency.test.ts::"ACC-V11-GIT-01/03: concurrent isolated units integrate serially with ordered, evidenced receipts" |
| REQ-V-08 | **RR** | tested | A completed unit publishes a typed artifact that is delivered to another unit at most once, a dependent unit receives exactly its declared dependencies' summaries, and the operator can publish a typed message | ACC-V11-MAO-05, ACC-V11-CTX-02, ACC-V11-CTX-03 | [SPEC §6.3](SPEC.md) | [WP-4](COLLABORATION.md) | test:cli/test/operation_messages.test.ts::"ACC-V11-MAO-05: a completed unit's artifact reaches the next unit exactly once", test:cli/test/operation_messages.test.ts::"ACC-V11-CTX-02: a dependent unit receives exactly its declared dependencies' summaries", test:cli/test/operation_messages.test.ts::"ACC-V11-CTX-03: the operator command publishes through the store and rejects a bad recipient with exit 2" |
| REQ-V-09 | **RR** | tested | A context-budget block names the binding bound, the estimate and its source, and the recorded estimate carries the source | ACC-V11-CTX-01 | [SPEC §6.1.1](SPEC.md) | [WP-4](COLLABORATION.md) | test:cli/test/context_management.test.ts::"ACC-V11-CTX-01: the budget decision names the binding bound, the estimate and its source" |
| REQ-V-10 | **RR** | tested | Replay renders the recorded timeline once, in order, with contiguous indices, validates against the view schema, and writes nothing; `--dag --replay` is refused | ACC-V11-OBS-01, ACC-V11-OBS-02, ACC-V11-OBS-03, ACC-V11-OBS-04 | [SPEC §7.2](SPEC.md) | [WP-5](COLLABORATION.md) | test:cli/test/operation_view.test.ts::"ACC-V11-OBS-01: replay renders every event once, oldest first, with contiguous indices", test:cli/test/operation_view.test.ts::"ACC-V11-OBS-02/03: --replay --json carries the timeline and leaves the record byte-identical", test:cli/test/operation_view.test.ts::"ACC-V11-OBS-04: --dag and --replay together are refused and write nothing" |

## 2. Acceptance criteria without a required row

These are defined in `SPEC.md` §10 and are deliberately **not** claimed by a required row. Each is either covered by
another row's test (marked) or deferred with a reason.

| Criterion | State | Reason / covering row |
|---|---|---|
| ACC-V11-MAO-02 | covered by REQ-V-04 | asserted in `ACC-V11-MAO-02/09` in the concurrency suite |
| ACC-V11-MAO-09 (runner half) | covered by REQ-V-04 | same test |
| ACC-V11-OBS-05 | covered by REQ-V-03 | the hostile-status test is the same property |
| ACC-V11-GIT-02 (crash between enqueue and merge) | **not demonstrated** | the queue is in-memory and drains before the runner returns; a crash mid-queue is reconciled by `reconcileIntegrated`, which is tested for the single-unit path only. A dedicated two-unit crash-between-enqueue-and-merge test is owed. |
| ACC-V11-GIT-04 (a cancelled unit's queued integration is skipped) | **not demonstrated** | the skip path exists (`INTEGRATION_SKIPPED`); no test forces a cancel between enqueue and drain. Owed. |
| ACC-V11-CTX-04 (restore then resume is fail-closed) | **not demonstrated** | v1.0.0 asserted the consequence in prose only; v1.1 did not add the test. Owed. |
| ACC-V11-REG-01..05 | process gates | executed per `VALIDATION.md` §2, not unit tests; recorded in `VALIDATION.md` §9 and `STATUS.md` §4 |

## 3. Deferred items (no row)

| Item | Target | Reason |
|---|---|---|
| PR publication (`git.publish`) | v1.2 | needs an operation-level egress action; rejected fail-closed in v1.1 (DEC-V11-12) |
| TUI operation pane, in-view decisions | v1.2 | PTY qualification and a single mutation surface (DEC-V11-14) |
| Semantic retrieval over operation records | v1.2 | local index lifecycle and embedding-egress policy (DEC-V11-13) |
| `send_unit_message` agent tool | v1.2 | the operator channel is enough for v1.1; the tool is additive later |
| Projection of `maxConcurrentUnits` in the view | v1.2 | capacity is scheduler state; the view shows eligibility, not slots. Concurrency is visible through simultaneous `RUNNING` units. |
