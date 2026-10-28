# v1.1 proposal: context management for long operations

Status: proposed. Owner: unclaimed. Depends on: observability. Size: medium (2–3 weeks).

## What exists today

- Compaction with a committed archive (`COMPACTION_AND_CONTINUITY.md`): compaction is applied in memory, appended to the
  archive, and checkpointed in a fixed order; `read_archive` returns originals after resume.
- Context admission is fail-closed: a turn that cannot fit its request in the admitted budget is `BLOCKED`, never
  silently truncated (`cli/src/tokens.ts`, `admitContext`).
- Durable task state, continuation past the step limit, findings with progressive disclosure, and dependency summaries
  for downstream units already exist.
- There is no per-unit context budget, no cross-unit summary channel beyond `UnitRunContext.dependencies`, no semantic
  retrieval, and no arbitrary context checkpoint.

## What to build

1. **Per-unit context budget** derived from the unit's task, dependencies and role, bounded by the resource's advertised
   limit and the operator's setting. The budget is recorded with the unit and shown in the observability view; an
   over-budget unit parks with a decision instead of failing blind.
2. **Semantic retrieval over the operation's own record** (unit conversations, archive, findings, receipts), behind a
   local, opt-in index. Retrieval is evidence-returning (`read_archive`, `read_findings` semantics), never a silent
   summary injection; the model must still read what it relies on.
3. **Cross-unit context sharing**: a completed unit publishes a bounded summary plus pointers (files, receipts,
   conversation ids) that downstream units may request explicitly. Summaries are operator-visible and never substitute
   for a verification artifact.
4. **Context checkpoints**: named, durable snapshots of a unit's message set that an operator can restore for a retry,
   with the same candidate-identity and verification consequences as a restart (documented, tested).

## Design constraints

- No new implicit compaction path. Everything that removes content must still be committed to the archive in the
  documented order, so continuity evidence keeps holding.
- Retrieval must be local-only by default; any remote embedding provider is an egress action with its own authorization
  and evidence.
- A summary is never verification evidence: `TurnResult`, verifier and independence gates are unchanged.
- Budgets must be deterministic for a given configuration and recorded input sizes so the reproducibility evidence can
  still explain a decision.

## Acceptance

- A long operation (the existing lifecycle fixture extended with a multi-hour synthetic turn stream) stays within the
  resource limit across compactions, and every removed message is recoverable from the archive after resume.
- A unit whose budget cannot fit its task parks with a decision that names the limit, the estimate and its source.
- Retrieval returns only content that exists in the operation record, with stable ids; a deleted or compacted item is
  reported as such, never fabricated.
- Restoring a context checkpoint produces a turn whose verification consequences are the documented ones (fail-closed
  after a restart).
- Reproducibility evidence still passes with a unit-sized budget on.

## Qualification impact

- Re-run the continuity/compaction cells and the durability cells; context admission is part of the v1.0.0 evidence.
- If a remote embedding provider is offered, it needs the provider qualification path (`ACCEPTANCE.md`).

## Risks

- Retrieval and summaries are a plausible route to unverified claims; keep them advisory and make the UI show what was
  retrieved.
- Token estimates are already heuristic; changing the budget model can shift every qualification timing. Record the
  estimate source in the evidence.
