# v1.1 scope proposals

These four proposals cover the work deliberately left out of v1.0.0. The v1.0.0 release candidate landed exactly one
piece of that list — test-first durable work units (`docs/v1.0.0/TDD-WORK-UNITS.md`, PR #292) — because it reused the
existing execution model and did not move the operation state schema.

Everything here changes the scheduler, the operation state, or the verification evidence model, so it must not land
inside a stable release. Each proposal states what exists today, what changes, what it costs, and how it is qualified.

## Sequence

| Order | Proposal | State at v1.1.0 | Remaining |
|---|---|---|---|
| 1 | [Operation observability](OPERATION_OBSERVABILITY.md) | View and replay shipped; terminal safety and schema validation completed | TUI pane, in-view decisions (v1.2) |
| 2 | [Git-aware operations](GIT_AWARE_OPERATIONS.md) | Isolation, integration queue, conflict policy, recovery and evidenced receipts shipped | PR publication (v1.2), fail-closed until then |
| 3 | [Context management](CONTEXT_MANAGEMENT.md) | Per-unit budget (with estimate source), checkpoints, and cross-unit sharing through the message channel | Semantic retrieval (v1.2) |
| 4 | [Multi-agent orchestration](MULTI_AGENT_ORCHESTRATION.md) | Deterministic parallel due-sets, serialised integration, typed channel, failure semantics | Unit-authored messages (v1.2) |

Documents for this release: [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) (baseline, reconciliation, traceability),
[`SPEC.md`](SPEC.md) (normative specification and acceptance criteria), [`REQUIREMENTS.md`](REQUIREMENTS.md) (enforced
ledger), [`COLLABORATION.md`](COLLABORATION.md) (work packages and contracts), [`VALIDATION.md`](VALIDATION.md) (gates
and execution record), [`DECISIONS.md`](DECISIONS.md) (xerj research log and decisions), [`STATUS.md`](STATUS.md)
(resumable programme state).

## Ground rules

- Each proposal is a separate, individually reviewable release slice; none may merge behind a stable tag that has not
  re-run the qualification evidence it invalidates.
- Every slice keeps the fail-closed properties v1.0.0 established: truthful `TurnResult`, verifier/baseline gates,
  candidate identity, durable recovery, and provider failure classification. New features may add evidence, never relax
  those gates.
- Every slice must state its effect on the v1.0.0 qualification evidence (`docs/v1.0.0/ACCEPTANCE.md`): which E2 cells,
  provider checks, and reproducibility runs must be repeated, and which ledger rows it touches.
- Anything that changes `DurableOperationState` needs a schema version and a tested migration from a v1.0.0 record.
  v1.1.0 finally enforces this: `CURRENT_OPERATION_SCHEMA_VERSION = 2`, a pure v1→v2 migration, a
  `.pre-migration-v1` backup of the whole record, and a fail-closed refusal of a newer record. The earlier slices had
  changed the document without bumping its version; that omission is repaired, not repeated.

## Not in v1.1

- Hosted or remote multi-tenant execution (the trust boundary is a local operator).
- Model-authored verifiers or self-approval; all new automation still submits to the existing gates.
- Automatic test generation from requirement text. TDD stays test-first authoring; generation is a separate research
  item with its own evaluation harness.
