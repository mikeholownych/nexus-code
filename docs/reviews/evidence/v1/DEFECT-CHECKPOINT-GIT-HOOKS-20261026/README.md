# DEFECT: checkpoint create/prune ran workspace Git hooks

| | |
|---|---|
| Base revision | `62e541c9e170a51d02420753f0807c14d65d7074` (`origin/main`) |
| Branch | `v1/defect-checkpoint-git-hooks` |
| Affected behavior | Checkpoint operations ran Git in the workspace with repository hooks enabled. `update-ref` fired `reference-transaction`; the dirty-worktree `git stash create` fired `post-index-change`; and `git reset --hard` in restore fired both. A workspace containing those hooks (for example an extracted archive or a repository whose hooks were installed by an earlier command) executed them during ordinary checkpoint creation, pruning or restore. |
| Severity | Medium: arbitrary code execution from workspace-controlled Git hooks during ordinary checkpoint operations. |

## Reproduction (pre-fix)

The new tests initialize a real Git workspace, install executable `reference-transaction` and `post-index-change`
hooks that create a marker, then exercise dirty creation, pruning and restore. Pre-fix they failed with:

```
AssertionError: checkpoint creation executed a workspace hook
AssertionError: checkpoint pruning executed a workspace hook
AssertionError: checkpoint restore executed a workspace hook
```

## Fix

Pass `-c core.hooksPath=/dev/null` and (where relevant) `-c core.fsmonitor=false` before the Git subcommand for
checkpoint ref updates, dirty `stash create`, the changed-path diff and restore `reset --hard`. This overrides
repository/worktree/include configuration before any hook or fsmonitor command can run.

## Verification

- New `cli/test/checkpoint_git_hook.test.ts`: dirty creation, prune and restore hook tests fail on base and pass after;
  creation also asserts the checkpoint ref exists.
- `checkpoint_index_lock.test.ts` + `checkpoint_snapshot_confinement.test.ts` together with the new file: 15/15.
- `tsc`, `git diff --check`: pass; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- The checkpoint path now guards its ref updates, `stash create`, dirty diff and restore reset. `rev-parse`/`show` and
  `git clean` remain unguarded but do not run repository hooks; `diff.external`/textconv and other repository config
  execution outside these guarded invocations are not covered, so a hostile workspace should still be treated as code.
- Checkpoint ids remain validated by the existing checkpoint parser; this change does not alter state-file identity rules.
