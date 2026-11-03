# v1.1 proposal: context management for long operations

Status (reconciled 2026-10-31): per-unit budget (1, now with a recorded estimate source), context checkpoints (4) and
cross-unit sharing (3, through the typed message channel) are implemented; semantic retrieval (2) is deferred to v1.2
(DEC-V11-13). See [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §2.3 and [`REQUIREMENTS.md`](REQUIREMENTS.md) REQ-V-08/09.

## What exists today

Historical context (kept for the record; this paragraph predates the slices and contradicted the status line):

- Compaction with a committed archive (`COMPACTION_AND_CONTINUITY.md`): compaction is applied in memory, appended to the
  archive, and checkpointed in a fixed order; `read_archive` returns originals after resume.
- Context admission is fail-closed: a turn that cannot fit its request in the admitted budget is `BLOCKED`, never
  silently truncated (`cli/src/agent.ts`, `admitContext`; `cli/src/tokens.ts` holds `isContextAdmissible`).
- Durable task state, continuation past the step limit, findings with progressive disclosure, and dependency summaries
  for downstream units already existed before this work.

## What slice 3 ships

`units[].contextBudget` (tokens) with a pre-inference preflight that uses the agent's own admission estimate, records
`unit.context` (including the **source** of the binding bound: `operator-budget` or `agent-estimate`), and blocks with
`CONTEXT_BUDGET` when the operator's cap is the binding limit. The only offered remedy is `lift_context_budget`, plus
the scheduler's terminal stop: reassignment cannot clear a per-unit cap, and revise only grows the prompt. The estimate
is a start-of-turn lower bound; the cap does not bound mid-turn growth (the resource limit does). Durable
`nexus operation checkpoint|checkpoints|restore` for a unit's conversation, with a hash-checked checkpoint, a
pre-restore backup kept with the checkpoints, the operation lock held across the write, fail-closed resume and
path-safe names. View/schema project both. Implementation and evidence:
`docs/reviews/evidence/v1.1/CONTEXT-MANAGEMENT-20261028/README.md`; the estimate-source addition and the corrected
decision text are in `cli/test/context_management.test.ts` (ACC-V11-CTX-01).

Resolved since: cross-unit sharing ships as the typed message channel (item 3, `cli/src/core/operation_messages.ts`),
not as a separate summary store. Still deferred: semantic retrieval (item 2).

## What to build

1. **Per-unit context budget** (shipped as an operator cap; automatic sizing from task complexity is not) bounded by
   the resource's advertised limit and the operator's setting. The budget is recorded with the unit and shown in the
   observability view; an over-budget unit blocks with a decision instead of failing blind.
2. **Semantic retrieval over the operation's own record** (unit conversations, archive, findings, receipts), behind a
   local, opt-in index. Retrieval is evidence-returning (`read_archive`, `read_findings` semantics), never a silent
   summary injection; the model must still read what it relies on.
3. **Cross-unit context sharing** (shipped as the message channel): a completed unit publishes an `artifact` message
   carrying its verified summary and pointers (receipt commit, unit id); a reviewer publishes a `verdict`. Downstream
   units receive undelivered messages addressed to them or to the operation, at most once, in the same save that starts
   them. The operator can publish a `request` with `nexus operation message`. There is no shared mutable memory.
   Summaries are operator-visible and never substitute for a verification artifact.
4. **Context checkpoints** (shipped): named, durable snapshots of a unit's task state that an operator can restore for
   a retry, with the same verification consequences as a restart (fail-closed, documented and tested).

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
- A unit whose budget cannot fit its task blocks with a decision that names the binding bound, the estimate and its
  source (`ACC-V11-CTX-01`).
- Retrieval (deferred) returns only content that exists in the operation record, with stable ids; a deleted or
  compacted item is reported as such, never fabricated.
- Restoring a context checkpoint produces a turn whose verification consequences are the documented ones (fail-closed
  after a restart). The v1.0.0 evidence asserted the printed consequence only; a resume-level test is still owed
  (`REQUIREMENTS.md` §2, ACC-V11-CTX-04).
- Reproducibility evidence still passes with a unit-sized budget on.

## Qualification impact

- Re-run the continuity/compaction cells and the durability cells; context admission is part of the v1.0.0 evidence.
  The v1.1 change to `unit.context` is additive (one new optional field), so the estimate numbers and timings are
  unchanged.
- If a remote embedding provider is offered, it needs the provider qualification path (`ACCEPTANCE.md`).

## Risks

- Retrieval and summaries are a plausible route to unverified claims; keep them advisory and make the UI show what was
  retrieved.
- Token estimates are already heuristic; changing the budget model can shift every qualification timing. Record the
  estimate source in the evidence.
