# v1.1.0: scope, status and documents

This directory holds two things that must not be confused:

1. **The implemented v1.1.0 scope** — four proposals, their specification, the enforced acceptance ledger and the
   release plans. These describe behaviour that exists in the source at the v1.1.0 candidate commit.
2. **A parallel post-v1.0.0 roadmap** ([`ROADMAP.md`](ROADMAP.md), [`SPEC-EVALUATION.md`](SPEC-EVALUATION.md),
   [`SPEC-OBSERVABILITY.md`](SPEC-OBSERVABILITY.md), [`POSITIONING.md`](POSITIONING.md),
   [`LANGSMITH_REVIEW.md`](LANGSMITH_REVIEW.md)). It was merged to `main` on 2026-10-31 (PR #371) **after** this
   review's baseline, and it also calls itself "v1.1.0". Its work packages are **not implemented** in this release.

The naming collision is a blocking decision, not a documentation problem: see
[`DECISIONS.md`](DECISIONS.md) Q6. Until it is resolved, this branch calls its own work "the v1.1.0 scope" and does
not claim that the `WP-11xx` roadmap has shipped.

## 1. Implemented scope (authoritative for this branch)

| Order | Proposal | State at this candidate | Remaining |
|---|---|---|---|
| 1 | [Operation observability](OPERATION_OBSERVABILITY.md) | View and replay shipped; terminal safety and schema validation completed | TUI pane, in-view decisions (v1.2) |
| 2 | [Git-aware operations](GIT_AWARE_OPERATIONS.md) | Isolation, integration queue, conflict policy, recovery and evidenced receipts shipped | PR publication (v1.2), fail-closed until then |
| 3 | [Context management](CONTEXT_MANAGEMENT.md) | Per-unit budget (with estimate source), checkpoints, and cross-unit sharing through the message channel | Semantic retrieval (v1.2) |
| 4 | [Multi-agent orchestration](MULTI_AGENT_ORCHESTRATION.md) | Deterministic parallel due-sets, serialised integration, typed channel, failure semantics | Unit-authored messages (v1.2) |

Programme documents:

| Document | Purpose |
|---|---|
| [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) | Baseline, merged-vs-proposed reconciliation (including §2.5 on the parallel roadmap), defect register, traceability matrix |
| [`SPEC.md`](SPEC.md) | Normative specification: architecture, contracts, state, migration, failure semantics, acceptance criteria |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Enforced acceptance ledger (`check_requirements.mjs --ledger … --enforce`) |
| [`COLLABORATION.md`](COLLABORATION.md) | Work packages, frozen contracts, file boundaries, integration order, assignment briefs |
| [`VALIDATION.md`](VALIDATION.md) | Gate definitions, end-to-end scenarios, migration/rollback checks, execution record |
| [`DECISIONS.md`](DECISIONS.md) | xerj configuration and research log, decisions, assumptions, open questions |
| [`STATUS.md`](STATUS.md) | Resumable programme state: what was actually run, what remains |

## 2. Every slice changes the same three things

- **The scheduler or the operation document.** Anything that changes `DurableOperationState` needs a schema version
  and a tested migration from a v1.0.0 record. This release finally enforces it:
  `CURRENT_OPERATION_SCHEMA_VERSION = 2`, a pure v1→v2 migration, a `.pre-migration-v1` backup of the whole record, and
  a fail-closed refusal of a newer record. Earlier slices had changed the document without bumping its version; that
  omission is repaired, not repeated.
- **The verification evidence model.** No slice may relax a v1.0.0 gate: truthful `TurnResult`, verifier/baseline
  gates, candidate identity, durable recovery, provider failure classification. New features add evidence.
- **The qualification ledger.** Every slice states which v1.0.0 evidence it invalidates (`docs/v1.0.0/ACCEPTANCE.md`),
  and which ledger rows it touches.

Each proposal is a separate, individually reviewable slice; none may merge behind a stable tag that has not re-run
the qualification evidence it invalidates.

## 3. Not in this scope

- Hosted or remote multi-tenant execution (the trust boundary is a local operator).
- Model-authored verifiers or self-approval; all new automation still submits to the existing gates.
- Automatic test generation from requirement text. TDD stays test-first authoring; generation is a separate research
  item with its own evaluation harness.
- PR publication, the TUI operation pane, in-view decisions, semantic retrieval over operation records and a
  unit-authored message tool — each deferred to v1.2 with a dated rationale in [`DECISIONS.md`](DECISIONS.md).
- The `WP-11xx` post-v1 roadmap packages (OpenTelemetry tracing, `nexus eval`, GBNF tool grammars, Composio bridges,
  dependency modernization): **not implemented here**. Their dispositions and the overlap with item 1 above are in
  [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §2.5.
