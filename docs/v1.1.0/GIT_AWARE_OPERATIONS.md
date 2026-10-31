# v1.1 proposal: git-aware operations

Status (reconciled 2026-10-31): slices 1–3, recovery, the deterministic integration queue and evidenced receipts are
implemented; PR publication (4) is deferred to v1.2 and is now **rejected fail-closed** rather than silently ignored
(DEC-V11-12). See [`ROADMAP-REVIEW.md`](ROADMAP-REVIEW.md) §2.2 and [`REQUIREMENTS.md`](REQUIREMENTS.md) REQ-V-07.
Owner: unclaimed. Depends on: observability (for integration visibility). Size: medium (2–3 weeks).

## What exists today

Historical context (kept for the record; superseded by the shipped slices below): before this work, an agent turn
could run in its own worktree via `WorktreeManager`, but a durable unit had no branch, no integration step and no
conflict policy. `CandidateIdentity` already computed a content-addressed view of the working tree, which is the
natural unit boundary for a branch. All of that now exists for operations; see "What slice 2 ships".

## What slice 2 ships

`spec.git = { isolate: true, baseRef? }`: an integration worktree/branch per operation, a worktree/branch per unit, a
deterministic integration queue at unit completion, receipts persisted in the operation state, a `MERGE_CONFLICT`
decision when a merge conflicts, an `INTEGRATION_FAILED` decision when the merged tree fails the unit's verifier, and
recovery (idempotent integration, receipt reconciliation, missing-worktree fail-closed, restart). Implementation and
evidence: `docs/reviews/evidence/v1.1/GIT-AWARE-OPERATIONS-20261028/README.md`.

Still proposed below: PR publication, and conflict policies beyond "stop and ask".

## What to build

1. **Opt-in per-unit isolation** in the operation spec: operation-level `git: { isolate: true, baseRef? }`. Every unit
   runs in its own worktree on a branch named for the operation and unit. Per-unit `git` and role-based sharing of the
   integration worktree are **not** implemented; every unit gets its own worktree, which is the safer default under
   concurrency.
2. **Integration queue**: after a unit completes, its integration is queued and merged into the operation branch one at
   a time, in arrival order (v1.1.0: `OperationRunner.enqueueIntegration`). Dependency order is already guaranteed by
   the scheduler, since a dependent unit cannot start before its dependency is `COMPLETE`. Each integration is a merge
   commit (`--no-ff`; there is no fast-forward path) with a receipt that records the unit, the branch and commit, the
   merge tree, the **candidate digest**, the **executed tests** and the 1-based merge **sequence**. A receipt omits
   `candidate`/`tests` when the worktree was already gone or the unit produced no verifier — an absent field is honest
   evidence.
3. **Conflict policy**: a textual conflict parks the unit with an escalation decision whose options are `retry`
   (resolve in the workspace and try again) and `revise`, plus the scheduler's terminal "stop the operation". A
   required unit cannot be dropped and assignment cannot resolve a textual conflict, so neither is offered. There is no
   automatic model-driven conflict resolution; "resolve in the workspace and retry" is the operator path. Verified by
   `cli/test/operation_git.test.ts` ("a conflict parks the unit with retry and revise and leaves both branches intact").
4. **PR publication** (deferred to v1.2): an opt-in `git: { publish: "pr" }` creates one branch for the operation and
   a PR whose body is generated from unit summaries, verification evidence and the requirement ledger. Creating a PR is
   an egress action. It needs an operation-level decision (a dedicated `publish_pr` action) whose payload passes
   `InformationFlowBoundary`, plus an egress recorder proving no request is made without an applied authorization. A
   shell `git push`/`gh` from `run_command` is **not** an acceptable implementation: it runs under the `exec` effect
   and bypasses the egress boundary. Until then the spec validator rejects the key with exit 2.
5. **Recovery**: the operation records the integration state (branch tip per unit, integrated commits) so a restart can
   resume integration without re-merging.

## Design constraints

- A unit's branch tip is part of the durable state and is validated on resume; a missing or moved tip fails closed with
  an operator decision, never a silent re-run on a different tree.
- Integration must not bypass the verification gates: a unit is integrated only with the evidence the unit model already
  requires; the merge is recorded, not re-judged.
- Worktrees must be cleaned up on every path (complete, cancel, crash-then-resume) and the legacy worktree-record
  migration (#275) must be exercised by the new paths.
- The operation branch must never be the operator's checked-out branch without an explicit opt-in.

## Acceptance

- Two units, each on its own worktree, integrate serially even when they complete in the same scheduling iteration; the
  operation branch contains both commits and the receipts name them, with distinct sequence numbers and the candidate
  and tests each was accepted with (`cli/test/operation_concurrency.test.ts`, ACC-V11-GIT-01/03).
- A forced conflict parks the operation with a decision; resolving in the workspace and retrying completes it.
- A crash between "unit complete" and "integrated" resumes to the same integration decision, with no duplicated merge.
- `publish: pr` with no authorization makes no network call (asserted by a local egress recorder).
- The full lifecycle leaves **no unit worktree** behind when the worktree is clean. This is deliberately narrower than
  the earlier claim: a unit worktree with uncommitted or ignored files is preserved rather than destroyed, and the
  integration worktree is retained as the operator's inspection surface. Every retained worktree is named with its
  reason in the event log. Dirty-worktree preservation is asserted by `cli/test/operation_git.test.ts`.

## Qualification impact

- Re-run the E2 lifecycle cell on at least one platform per runtime, and the durability cells (power-loss, synthetic
  journal) because integration adds durable transitions — in particular the in-memory integration queue, whose
  crash-between-enqueue-and-merge behaviour is not yet demonstrated (see `REQUIREMENTS.md` §2).
- No provider or reproducibility re-qualification.

## Risks

- Integration order and rebases can invalidate candidate identity; treat the integrated commit as a new candidate and
  re-run the unit's verifier as an integration check.
- Worktree churn interacts with the configured-hook guards (#277/#279). Those guards must be exercised on the new paths.
