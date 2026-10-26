# DEFECT: worktree-bound task recovery discarded conversation and broke re-resume

| | |
|---|---|
| Base revision | `468646bb58f22db573b06db2c2fc889b444df6cc` (`origin/main`, after PR #246) |
| Branch | `v1/defect-recover-worktree-conversation` |
| Affected behavior | Three failures on the speculative-worktree recovery path:<br>1. `AutonomousAgent.recoverFromTaskState` restored the durable envelope (messages, objective, findings, archive, plan, baseline obligations), then switched to the recorded worktree. The switch calls `setWorkspace`, which ends in `resetConversation()` and replaces `messages` with a single system prompt, clearing objective and findings. A resumed worktree task silently lost the conversation it had just recovered.<br>2. `checkpointDurableState` recorded `workspacePath` as the **active worktree**, so any checkpoint after the resume (and, in fact, every checkpoint of a normal worktree run) rewrote the task's identity to the internal checkout. The next `--resume` launched from the repository root failed with `WorkspaceIdentityMismatchError`, and `listTasks({workspace: root})` no longer listed the task.<br>3. Recovery set `activeWorktree` but never `originalWorkspace`, so `/merge` and `/discard` merged or removed the worktree without switching the agent back to the primary checkout. |
| Severity | High: `nexus run --resume` / `/recover` / `/merge` / `/discard` of a worktree task loses conversation context, becomes unresumable from the repository root, or leaves the agent in a removed checkout. |

## Reproduction (pre-fix)

`cli/test/recover_worktree_conversation.test.ts` creates a git repository, a real managed worktree through
`WorktreeManager.createWorktree`, records a task state whose `worktreeBinding` points at it, then recovers that
task through a fresh `AutonomousAgent`. The three regressions fail before the fix:

```
✖ recovering a worktree-bound task keeps the restored conversation
  AssertionError [ERR_ASSERTION]: recovery discarded the restored conversation
✖ a worktree-bound task stays resumable after a resumed turn checkpoints
  AssertionError [ERR_ASSERTION]: checkpoint recorded the worktree as the task workspace
✖ discarding a recovered worktree returns to the primary workspace
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal (workspace still the worktree)
```

The first also fails on the pre-PR246 base `62e541c`; the second and third behaviours are independent of PR #246.

## Fix

1. Move the worktree switch in `recoverFromTaskState` ahead of the field restoration, so `setWorkspace` →
   `resetConversation` runs first and the recovered messages, objective, findings, archive and plan are applied
   afterwards. `activeWorktree` is still set before the switch so the rebuilt bridge keeps the worktree sandbox
   posture, and the switch is still gated on `worktreeStatus === "consistent"`.
2. `checkpointDurableState` now writes the primary workspace identity (`primaryWorkspacePathIdentity`) whenever a
   worktree is active; the `worktreeBinding` continues to name the active checkout. The record therefore keeps the
   repository-root identity that `--resume`, `listTasks` and retention resolve against.
3. `recoverFromTaskState` records `originalWorkspace` from the primary identity before switching, so `/merge` and
   `/discard` return the agent to the checkout it was resumed from.

No behaviour changes without a worktree binding: the recovery block is not entered and `checkpointDurableState`
keeps using the current workspace identity exactly as before.

## Verification

- Three regressions fail on base `468646b` and pass at HEAD. Each behaviour was also re-checked in isolation by
  reverting only its fix: reverting the reorder fails test 1, reverting the checkpoint identity fails test 2, and
  reverting the `originalWorkspace` line fails test 3.
- Test 2 additionally re-recovers through a **third** fresh process after the resumed turn checkpointed, asserting the
  conversation and worktree switch survive and the record no longer mismatches the repository root.
- Test 3 discards the recovered worktree through the public API and asserts the workspace returns to the primary
  checkout and the worktree directory is gone.
- Focused: `recover_worktree_conversation.test.ts` (3) + `state.test.ts` (11) + `system_journey.test.ts` (2) +
  `checkpoint_index_lock.test.ts` (4) + `retention.test.ts` (12) = **32/32 pass**.
- `tsc --noEmit`, `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.
- Pre-existing failures in `durable_continuity.test.ts` / `context_convergence.test.ts` / `convergence_invariants.test.ts`
  are identical on base (A/B verified for `convergence_invariants`: 20 pass / 10 fail both sides) and are unrelated:
  those files record no worktree binding.

## Residual risk

- `worktreeStatus === "consistent"` only checks that the recorded path exists. Recovery still does not prove the
  directory is the expected linked worktree of the primary repository or that its branch matches the recorded branch.
- Resuming **from inside** the internal `.nexus/worktrees/<taskId>` checkout is refused with a workspace-identity
  mismatch because the durable identity is the repository root. The root is the supported resume entry point; the
  internal checkout is not.
- The worktree binding's `createdAt` is synthesised on recovery; it was already not persisted by `activeWorktree`.
