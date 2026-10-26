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
   repository-root identity that `--resume` and `listTasks({workspace: root})` resolve against (retention reads the
   field only for reporting and its `/tmp/nexus-test-*` pollution heuristic).
3. `recoverFromTaskState` records `originalWorkspace` from the primary identity before switching, so `/merge` and
   `/discard` return the agent to the checkout it was resumed from.

No behaviour changes without a worktree binding: the recovery block is not entered and `checkpointDurableState`
keeps using the current workspace identity exactly as before.

## Verification

- Three regressions fail on base `468646b` and pass at HEAD. Each behaviour was also re-checked by reverting only its
  fix: reverting the reorder fails tests 1 and 2 (test 2 also asserts the restored conversation), reverting the
  checkpoint identity fails only test 2, and reverting the `originalWorkspace` line fails only test 3.
- Test 2 additionally re-recovers through a **third fresh `AutonomousAgent` in the same process** (state re-read from
  disk) after the resumed turn checkpointed, asserting the conversation and worktree switch survive and the record no
  longer mismatches the repository root.
- Test 3 discards the recovered worktree through the public API and asserts the workspace returns to the primary
  checkout and the worktree directory is gone.
- Focused: `recover_worktree_conversation.test.ts` (3) + `state.test.ts` (11) + `system_journey.test.ts` (2) +
  `checkpoint_index_lock.test.ts` (4) + `retention.test.ts` (12) = **32/32 pass**.
- Revalidated the amended regression at rebased snapshot `e964e4b54bf8a5e1d9191749340dae9edfeb22c8`: `npm run build --prefix cli`
  passed, then `node scripts/run_tests.mjs test/recover_worktree_conversation.test.ts` from `cli/` passed **3/3**.
  The runner provided isolated `HOME` and XDG directories. A separate full-suite attempt was interrupted after
  identifying missing build metadata and an unavailable local inference endpoint; it is not a passing suite result.
- At snapshot `87efa6f48cc1a0508f0d1e4848bb04120e5341d9`, a further regression assertion confirms the committed
  archived message is restored and searchable through the resumed agent's `read_archive` handler. `npm ci --prefix cli`,
  `npm run build --prefix cli`, and the focused recovery test passed (3/3) in an immutable detached worktree with
  isolated `HOME`, `XDG_CONFIG_HOME`, and `NEXUS_STATE_DIR`.
- `tsc --noEmit`, `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.
- Pre-existing failures in `durable_continuity.test.ts` / `context_convergence.test.ts` / `convergence_invariants.test.ts`
  are identical on base (A/B verified for `convergence_invariants`: 20 pass / 10 fail both sides) and are unrelated:
  those files record no worktree binding.

## Residual risk

- `worktreeStatus === "consistent"` only checks that the recorded path exists. Recovery still does not prove the
  directory is the expected linked worktree of the primary repository or that its branch matches the recorded branch.
- **Pre-fix records are not migrated.** A durable record written by an earlier build (including `5d03e7c`, where
  `checkpointDurableState` still stored the internal worktree) keeps `workspacePath` = `.nexus/worktrees/<taskId>`.
  At HEAD, resuming such a record from the repository root still fails with `WorkspaceIdentityMismatchError`, while
  resuming it from inside the internal checkout succeeds but binds the `WorktreeManager` to that checkout, so
  `/discard` cannot remove the real worktree. The defect-2 symptom therefore persists for in-flight pre-fix records
  unless their workspace identity is explicitly normalized before recovery; writing a checkpoint at HEAD cannot
  help because recovery fails before it can reach that checkpoint. v1.0.0 has not shipped, so no released-state
  migration is included here. Supporting these records requires a separate, validated normalization change in the
  durable-state loader (for example, mapping a recorded managed worktree path back to its verified primary
  repository), which is outside this slice's claimed files.
- The internal checkout is not a supported resume entry point: its runner records `workspacePath` as that checkout,
  and `repl /resume` of a session saved inside the worktree re-enters it with no `activeWorktree`.
- The worktree binding's `createdAt` is synthesised on recovery; it was already not persisted by `activeWorktree`.
- "No behaviour changes without a worktree" differs by site: recovery is gated on the **binding**, while
  `checkpointDurableState` is gated on **`activeWorktree`** (a live, unresolved worktree), which is the same
  condition under which the old code recorded the worktree path.
