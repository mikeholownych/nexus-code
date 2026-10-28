# v1.1 proposal: git-aware operations

Status: slices 1–3 and recovery implemented (`v1/feature-git-aware-operations`); PR publication (4) remains proposed.
Owner: unclaimed. Depends on: observability (for integration visibility). Size: medium (2–3 weeks).

## What exists today

- `WorktreeManager` creates and disposes per-task worktrees; an agent turn can run in its own worktree, and `/merge`,
  `/discard` and merge receipts already exist for interactive sessions (`cli/src/worktree.ts`).
- Durable units run against the operation's workspace. A unit's conversation is durable, and the runner checkpoints after
  every transition, but the *repository history* is not part of the unit model: there is no per-unit branch, no
  integration step, and no conflict policy.
- `CandidateIdentity` already computes a content-addressed view of the working tree, which is the natural unit boundary
  for a branch.

## What slice 2 ships

`spec.git = { isolate: true, baseRef? }`: an integration worktree/branch per operation, a worktree/branch per unit, a
deterministic integration queue at unit completion, receipts persisted in the operation state, a `MERGE_CONFLICT`
decision when a merge conflicts, an `INTEGRATION_FAILED` decision when the merged tree fails the unit's verifier, and
recovery (idempotent integration, receipt reconciliation, missing-worktree fail-closed, restart). Implementation and
evidence: `docs/reviews/evidence/v1.1/GIT-AWARE-OPERATIONS-20261028/README.md`.

Still proposed below: PR publication, and conflict policies beyond "stop and ask".

## What to build

1. **Opt-in per-unit isolation** in the operation spec: `git: { isolate: true }` (operation level) or per unit. A write
   unit runs in a worktree on a branch named for the operation and unit; read-only and tester units may share the
   integration worktree (configurable).
2. **Integration queue**: after a unit completes, its branch is integrated into the operation branch in a deterministic
   order (dependency order, then completion order). Each integration is a merge commit (or fast-forward) with a receipt
   that records the unit, the candidate identity, the tests run, and the merge tree.
3. **Conflict policy**: a textual conflict parks the operation with an escalation decision whose options are exactly the
   existing kinds (`retry`, `revise`, `assign`, `drop`, `cancel`). There is no automatic model-driven conflict
   resolution in this slice; "resolve in the workspace and retry" is the operator path.
4. **PR publication** (not in slice 2): an opt-in `git: { publish: "pr" }` creates one branch for the operation and a PR
   whose body is generated from unit summaries, verification evidence, and the requirement ledger. Creating a PR is an
   egress action: it requires explicit operator authorization and is recorded as such.
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

- Two dependent units, each on its own worktree, integrate in dependency order; the operation branch contains both and
  the receipts name the commits.
- A forced conflict parks the operation with a decision; resolving in the workspace and retrying completes it.
- A crash between "unit complete" and "integrated" resumes to the same integration decision, with no duplicated merge.
- `publish: pr` with no authorization makes no network call (asserted by a local egress recorder).
- The full lifecycle (create, complete, cancel, crash/resume) leaves no worktree behind.

## Qualification impact

- Re-run the E2 lifecycle cell on at least one platform per runtime, and the durability cells (power-loss, synthetic
  journal) because integration adds durable transitions.
- No provider or reproducibility re-qualification.

## Risks

- Integration order and rebases can invalidate candidate identity; treat the integrated commit as a new candidate and
  re-run the unit's verifier as an integration check.
- Worktree churn interacts with the configured-hook guards (#277/#279). Those guards must be exercised on the new paths.
