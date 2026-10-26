# DEFECT: worktree-bound task recovery discarded the restored conversation

| | |
|---|---|
| Base revision | `468646bb58f22db573b06db2c2fc889b444df6cc` (`origin/main`, after PR #246) |
| Branch | `v1/defect-recover-worktree-conversation` |
| Affected behavior | `AutonomousAgent.recoverFromTaskState` restored the durable envelope (messages, objective, findings, archive, plan, baseline obligations), then switched to the recorded speculative worktree. The switch calls `setWorkspace`, which ends in `resetConversation()` and replaces `messages` with a single system prompt, clears `objective`, findings, the compaction archive and carried removals. A resumed worktree-bound task therefore started from scratch while still believing it was the same unit, and its restored conversation was silently lost. |
| Severity | High: `nexus run --resume` / `/recover` / work-unit retry of a worktree task loses all conversation and objective context, contradicting the durable-continuity contract. |

## Reproduction (pre-fix)

`cli/test/recover_worktree_conversation.test.ts` creates a git repository, a real linked worktree, records a
task state whose `worktreeBinding` points at it, then recovers that task through a fresh `AutonomousAgent`.
Before the fix the recovery succeeds but the new agent holds one rebuilt system message:

```
✖ recovering a worktree-bound task keeps the restored conversation
  AssertionError [ERR_ASSERTION]: recovery discarded the restored conversation
```

## Fix

Move the worktree switch in `recoverFromTaskState` ahead of the field restoration, so the `setWorkspace` →
`resetConversation` path runs first and the recovered messages, objective, findings, archive and plan are applied
afterwards. The worktree binding is still only honoured when the state manager reported
`worktreeStatus === "consistent"`, and `activeWorktree` is still set before the switch so the rebuilt bridge keeps
the worktree sandbox posture. No other behaviour changes: for tasks without a worktree binding the block is not
entered, so the recovery sequence is identical to before.

## Verification

- New `cli/test/recover_worktree_conversation.test.ts`: fails on base `468646b` (and on the pre-PR246 base
  `62e541c`) with the assertion above; passes after the change.
- The test asserts the recovered workspace is the recorded worktree, the full conversation (including the original
  system and assistant messages) and history count survive, the plan is restored, and the unverified-change
  obligation stays set.
- `recover_worktree_conversation.test.ts` + `state.test.ts`: 12/12 pass.
- `convergence_invariants.test.ts` A/B: 20 pass / 10 fail on base and the identical 10 named failures at HEAD, so
  the pre-existing failures are not caused by this slice (that file never records a worktree binding).
- `system_journey.test.ts` (worktree lifecycle) passes in the combined run.
- `tsc --noEmit`, `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- `worktreeStatus === "consistent"` only checks that the recorded path exists. Recovery still does not prove the
  directory is the expected linked worktree of the primary repository, nor that its branch matches the recorded
  branch. That validation gap predates this slice and is unchanged.
- Pre-existing failures in `durable_continuity.test.ts` / `context_convergence.test.ts` were observed in the same
  combined run; they are unrelated to worktree bindings (neither file records one) and are not addressed here.
