# Config-declared Git hooks: shared suppression for retention and checkpoints

| | |
|---|---|
| Base revision | `ceabfccf466ab39fc80c274400bae5aa0744a227` (`origin/main`) |
| Branch | `v1/defect-retention-configured-hooks-current` |
| Affected behavior | Git 2.54 added hooks declared in repository config (`hook.<name>.event` / `.command`). `core.hooksPath=/dev/null` does not disable them. Retention reference deletion, checkpoint creation (stash/ref update), pruning and restore (reset) could therefore execute a workspace-controlled hook even after PR #269/#270. |
| Severity | High on Git 2.54+: arbitrary code execution from repository config during ordinary cleanup/checkpoint operations. Older Git has no configuration hooks and is unaffected. |

## Fix

A shared helper, `cli/src/core/git_hook_guard.ts` (`envWithoutConfiguredHooks`), reads the effective `hook.*.event` entries (including `include.path`) and appends `hook.<name>.enabled=false` assignments to **`GIT_CONFIG_PARAMETERS`**, Git's own command-line config channel:

- It outranks the `GIT_CONFIG_COUNT` environment entries, so an inherited parameter cannot re-enable the hook; the previous retention-only implementation used `GIT_CONFIG_COUNT` and was bypassed by exactly that channel.
- Assignments are single-quote shell-quoted with `'\''` escaping, preserving friendly names containing `=`, spaces or quotes.
- If no configured hook matches the requested events, the environment is returned unchanged.
- A config read failure other than "no matches" is rethrown so callers fail closed.

Callers pass only the events their command can raise:

- retention ref deletion: `reference-transaction`;
- checkpoint create: `reference-transaction`, `post-index-change` (stash create and both ref updates);
- checkpoint prune: `reference-transaction`;
- checkpoint restore: `reference-transaction`, `post-index-change` (reset).

Traditional hooks remain disabled with the existing `-c core.hooksPath=/dev/null` override, which also outranks inherited parameters (verified on 2.54 and 2.43).

## Verification

- New checkpoint regression (Git 2.54+ only): a config include declares `reference-transaction` and `post-index-change` hooks; preconditions prove both fire on a raw `git update-ref`/`git stash create`, then checkpoint create, restore and prune must not run them. Against the pre-fix checkpoint source it fails with `checkpoint creation executed a configured hook`; it passes with the shared guard.
- Retention regression now sets an inherited `GIT_CONFIG_PARAMETERS` re-enable value; the previous `GIT_CONFIG_COUNT` implementation fails with `gc executed a configured Git hook`, the shared guard passes.
- Checkpoint + retention suites (checkpoint hook/index-lock/confinement and retention hook/shell/confinement): **34/34 pass on Git 2.54.0** ([log](git254-checkpoint-retention.log)) and **34/34 on host Git 2.43.0** ([log](git243-checkpoint-retention.log)).
- `tsc --noEmit` and `git diff --check`: clean; isolated `HOME`/`XDG_CONFIG_HOME`.

## Residual risk

- Configuration-declared hooks exist only on Git versions that support them; on older Git the `core.hooksPath` override remains the only control, as before.
- A malformed inherited `GIT_CONFIG_PARAMETERS` makes Git reject the config and the command fails; no hook executes, but retention has already unlinked the checkpoint record, so the ref is orphaned permanently (an orphan-ref sweep would be a separate improvement). Checkpoint creation fails before writing.
- Other Git invocations in checkpoint (diff/show/ls-files/rev-parse/clean) do not fire hooks; their config-driven helpers (`fsmonitor`, `diff.external`, textconv) are guarded separately.
- Filter drivers (`filter.*` via `.gitattributes`) remain a documented limitation for stash/reset; they are not hooks.
