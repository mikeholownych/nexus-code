# DEFECT: checkpoint create/prune ran workspace Git hooks

| | |
|---|---|
| Base revision | `62e541c9e170a51d02420753f0807c14d65d7074` (`origin/main`) |
| Branch | `v1/defect-checkpoint-git-hooks` |
| Affected behavior | Checkpoint operations ran Git in the workspace with repository hooks and config-driven programs enabled. `update-ref` fired `reference-transaction`; the dirty-worktree `git stash create` fired `post-index-change`; `git reset --hard` fired both; the changed-path `ls-files`/`clean` scans and every `git diff` (including `/checkpoint diff`) could run `core.fsmonitor`; and `git diff` could run repo-configured `diff.external`/textconv helpers. A workspace containing those hooks or config (for example an extracted archive, or a repository whose hooks were installed by an earlier command) executed them during ordinary checkpoint operations. |
| Severity | Medium: arbitrary code execution from workspace-controlled Git hooks during ordinary checkpoint operations. |

## Reproduction (pre-fix)

The new tests initialize a real Git workspace, install executable `reference-transaction` and `post-index-change`
hooks that create a marker, then exercise dirty creation, pruning and restore. Pre-fix they failed with:

```
AssertionError: checkpoint creation executed a workspace hook
AssertionError: checkpoint pruning executed a workspace hook
AssertionError: checkpoint restore executed a workspace hook or fsmonitor
AssertionError: checkpoint diff executed diff.external
AssertionError: checkpoint creation executed a workspace fsmonitor
```

## Fix

Pass `-c core.hooksPath=/dev/null` and `-c core.fsmonitor=false` (where relevant) before the Git subcommand for
checkpoint ref updates, dirty `stash create`, the changed-path diff, `ls-files` and `git show :path`, restore
`reset --hard` and `clean -fd`, and both `/checkpoint diff` invocations. The diff calls also pass `--no-ext-diff --no-textconv` so
repo-configured diff helpers cannot run. `-c` placement overrides repository/worktree/include configuration before
any hook, fsmonitor program or diff helper can run. The two remaining shell-string `rev-parse` calls were converted to
`execFileSync` for consistency.

## Verification

- `cli/test/checkpoint_git_hook.test.ts`: dirty creation, prune, restore, and a new diff test that configures
  `diff.external` and `core.fsmonitor` canaries (both `/checkpoint diff` forms) all fail on base and pass after;
  creation also configures an fsmonitor canary and asserts the checkpoint ref exists. The restore test now also
  configures an fsmonitor canary.
- `checkpoint_index_lock.test.ts` + `checkpoint_snapshot_confinement.test.ts` together with the new file: 16/16.
- `tsc`, `git diff --check`: pass; isolated `HOME`/`XDG_CONFIG_HOME` under the SUITE claim.

## Residual risk

- **Config-declared hooks (newer Git).** Git versions that support hooks declared in repository config
  (`hook.<name>.event` / `hook.<name>.command`) may run them even when `core.hooksPath` points at `/dev/null`.
  Repository config is workspace-controlled, so on such Git versions a hostile workspace can still execute a
  config-declared `reference-transaction` or `post-index-change` hook during checkpoint operations. This slice does
  not yet neutralize config-declared hooks; the separate retention follow-up is establishing the version matrix and a
  shared strategy. Until it lands, a hostile workspace on those Git versions must be treated as code.
- **Filter drivers remain reachable.** `filter.<name>.clean`, `.smudge` and `.process` (selected through the
  workspace's `.gitattributes`) still run external programs during `stash create`, the changed-path `git diff` and the
  worktree form of `/checkpoint diff` (clean filters), and during `reset --hard` (smudge filters). Git offers no
  single command-line switch to disable all filters. Neutralising them per invocation (`-c filter.<name>.clean=cat
  -c filter.<name>.smudge=cat -c filter.<name>.process=`) was tested, but it stores raw bytes instead of the filtered
  representation and makes Git LFS files appear modified after a restore; refusing to checkpoint whenever any filter
  is configured would break LFS workflows. A hostile workspace's `.gitattributes` plus filter config must therefore
  still be treated as code. This is documented rather than silently accepted.
- `git show :path` is guarded with `-c core.fsmonitor=false`; it prints index blobs and runs no hooks or diff helpers.
- Checkpoint ids remain validated by the existing checkpoint parser; this change does not alter state-file identity rules.
