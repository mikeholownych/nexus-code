# Git-aware operations (v1.1 slice 2): implementation evidence

| | |
|---|---|
| Base | `b293b441` (`origin/main`) |
| Branch | `v1/feature-git-aware-operations` |
| Surface | `spec.git = { isolate: true, baseRef?: "<ref>" }` on `nexus operation run` |
| Scope | Per-unit worktree isolation, integration queue, receipts, conflict decision, recovery. PR publication deferred. |

## What it does

An isolated operation creates one integration worktree/branch (`nexus/op-<id>/integration`) from `baseRef` (default
`HEAD`) at start, and gives every unit its own worktree and branch (`nexus/op-<id>/<unit>`) created from the current
integration tip. The agent runs with that worktree as its workspace, so candidate identity, verifier baselines, TDD
sidecars and tools all operate on the unit's tree. The operator's checkout is never written.

When a unit completes, the runner:

1. commits the unit's working tree on its branch (ignored build output is not staged),
2. merges the branch into the integration branch with `--no-ff`,
3. re-runs the unit's verifier on the merged tree when the unit completed with a passing, executed verifier,
4. records an `IntegrationReceipt` (unit, branch, unit commit, integrated commit, files, outcome, verification), and
5. removes the unit worktree (the branch and receipt stay for audit).

A textual conflict aborts the merge, leaves both branches and the integration tip untouched, and blocks the unit with a
`MERGE_CONFLICT` decision (retry after resolving, revise, or stop). A merge whose merged tree fails the verifier is
reset and blocks with `INTEGRATION_FAILED`.

## Recovery

- `integratedCommit` is persisted with the receipt. A crash between the merge and the scheduler transition is reconciled
  at runner start from the receipt, so the unit is not run again on an already-merged branch; the merged tree is still
  re-verified post hoc (`PASSED_POSTHOC`) and a failure is reported rather than recorded as verified.
- A blocked unit keeps its worktree. Retry resumes in it; restart prunes the stale Git registration, deletes the branch
  and recreates both from the integration tip (a fresh branch name is used if Git still refuses to delete it). An
  integration worktree that was deleted outside Nexus is repaired on resume (`worktree add <branch>`), because the
  branch is the source of truth.
- If the integration branch and worktree are both gone while the operation already integrated work, resume fails closed
  with an operation-level decision instead of recreating the branch from the base commit and silently dropping history.
  A worktree whose branch is gone is likewise unrepairable and raises that decision.
- Every receipt's integrated commit must still be an ancestor of the integration tip at resume; a branch reset or rewound
  in place stops the operation with the same decision instead of continuing on a tree that lost accepted work.
- A failed post-hoc check of an already-merged branch is not recorded as integrated: a retry re-checks the merged tree
  and merges any new work; a success records `PASSED_POSTHOC`.
- Integration is idempotent: an already-merged branch is recognised with `merge-base --is-ancestor` and recorded as
  `ALREADY_MERGED`; a stale `MERGE_HEAD` is aborted before the next merge.
- A recorded worktree that vanished is reported, not silently recreated: the unit is blocked with a decision offering a
  restart from the integration tip (which discards the old branch) or stop.
- An operator restart discards the unit's worktree and branch and recreates both from the current tip. If Git still
  refuses to delete the old branch (for example it is checked out in another worktree), a fresh branch name is used; the
  old branch is then left untouched rather than pointing the unit at it.

## Tests

`cli/test/operation_git.test.ts` (20 cases, real temporary Git repositories):

1. planning/creating the integration worktree is idempotent and refuses a non-Git workspace;
2. a unit runs on its own worktree, integrates, the operator checkout stays untouched, and `disposeUnit` keeps the branch;
3. a no-change unit integrates as `NO_CHANGES` without moving the tip;
4. a conflicting merge aborts cleanly, keeps both branches, lists the conflicted files and leaves the tip unchanged;
5. the merged tree is re-verified; a failure resets the merge and a pass is recorded;
6. a crash after the merge is recognised (`ALREADY_MERGED`) instead of merging twice;
7. restart discards the old working tree and branch and starts from the current tip;
8. a vanished worktree is reported by `missingWorktrees`;
9. the runner isolates each unit, integrates both completions (`VERIFIED`), records receipts and completes;
10. a resumed/parked unit whose branch point predates an integration conflicts and stops the operation with a
    `MERGE_CONFLICT` decision (retry/revise/stop);
11. a blocked unit keeps its worktree, and resolving the conflict then retrying runs that unit in the same worktree and
    completes the operation;
12. a worktree removed outside Nexus blocks with a restart-only decision, and the restart actually prunes and recreates
    it, then completes;
13. a deleted integration worktree is repaired on resume and integration proceeds;
14. a passing verifier that writes an artifact does not block the next integration (artifact cleaned);
15. a failed post-hoc check is not recorded as integrated, and the retry re-checks and merges the retry's new work;
16. the post-hoc path cleans its own verifier artifacts;
17. restart after an externally removed worktree (stale registration) really starts from the integration tip;
18. an operation with integrated history fails closed when its branch and worktree are both gone;
19. an unrepairable pair (worktree without branch) becomes an operation-level decision;
20. a rewound integration branch stops the operation before running more work, and the same decision resumes after the
    operator restores the branch (also covering unit-level history without a receipt).

The operation view projects `git` and per-unit `integration` receipts (schema updated and validated). Focused run:
`operation_git` + `operation_view` + `tdd_work_units` + `convergence_scheduling` + `operation_runner_refactor` +
`operation_account_identity` → **118/118 pass**; `tsc --noEmit` and `git diff --check` clean, isolated HOME/XDG.

## Residuals / not in this slice

- **PR publication is deferred.** This slice integrates locally; publishing an operation branch as a PR is an egress
  action that needs the authorization path and its evidence.
- Integration is sequential because the scheduler is: every unit starts from the latest integrated tip, so conflicts
  arise for units whose branch point is stale (resumed, parked, retried, or future concurrent units). That path is
  implemented and tested; automatic conflict resolution is deliberately absent.
- The integration re-check uses the unit's own passing verifier command with `bash -c` and the harness verifier deadline
  (`NEXUS_VERIFIER_TIMEOUT_SECS`). It is skipped (`NOT_RUN` in the receipt) when the unit completed without a passing,
  executed verifier, matching the existing unverified-completion semantics.
- Integration commits and merges are mechanical: a fixed Nexus author, `commit.gpgsign=false`, `--no-verify` and
  `core.hooksPath` pointed at an empty directory, so no repository hook or signing prompt can hang a headless
  integration. If that directory cannot be created (read-only `.nexus`), `--no-verify` still skips pre-commit and
  commit-msg, but a post-commit/post-merge hook could run. The merged tree is re-verified instead. A verifier that writes
  artifacts is cleaned (`reset --hard HEAD`, `clean -fd`) before the next integration.
- `git add -A` respects `.gitignore`, so ignored build output in a unit worktree is not integrated. A deliverable the
  repository ignores must be committed by the unit (or un-ignored) explicitly.
- Unit branches and the integration worktree are kept after completion/cancellation for review; unit worktrees are
  removed on completion/cancellation (kept while blocked). Removing branches/checkout is an operator action.
  `.nexus/` is excluded from Git.
- A post-hoc check of an already-merged branch cannot reset it (other units may have integrated on top); a failure is
  returned as an integration failure for the operator to inspect, not silently recorded as verified.
- Unit and integration worktrees have no installed dependencies (for example `node_modules`), so a verifier that needs
  them fails the unit (and the merged-tree check) unless dependencies are installed per worktree or the repository's
  verifier does not need them. `.nexus/worktrees` is a clean checkout by design.
- `git worktree prune --expire now` is repository-wide (Git has no per-worktree variant); it runs only when this
  operation's worktree is missing, but it can also drop another missing worktree's registration at that moment.
- `discardIntegrationWorktree` is not called automatically on a failed isolated start: the pair is left visible for the
  operator to repair rather than risk deleting an earlier same-id operation's work.
- Uncommitted operator changes are not part of an isolated operation: `baseRef` defaults to `HEAD`, so commit or stash
  first.
- No per-unit branch naming override and no reuse of the interactive `/merge` receipts; operations keep their own
  receipts so an operation's history is self-contained.
