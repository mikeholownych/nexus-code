# Retention cleanup: Git configuration-defined hook suppression

## Finding and correction

PR #269 disabled traditional repository hook scripts with `core.hooksPath=/dev/null`. Git 2.54 added named hooks defined in configuration, and those hooks are not disabled by `core.hooksPath`. The first 2.54 regression confirmed that a `reference-transaction` configuration hook still ran during checkpoint ref deletion even with `hooksPath` disabled. Git 2.54's per-hook `hook.<name>.enabled` setting is the compatible control.

The correction reads the effective `hook.*.event` entries (including config includes), finds each configured `reference-transaction` hook, and supplies `hook.<name>.enabled=false` to the ref-deletion command. Traditional hooks remain disabled with the fixed command-line `core.hooksPath=/dev/null` override. Configuration-defined hooks only exist on newer Git, so older versions need no extra handling.

The overrides are appended to **`GIT_CONFIG_PARAMETERS`**, Git's own command-line configuration channel, rather than only to `GIT_CONFIG_COUNT`. A parent Git process can pass configuration through `GIT_CONFIG_PARAMETERS`, and that channel outranks the `GIT_CONFIG_COUNT` environment entries; a test that sets an inherited `'hook.retention=extra.enabled'='true'` parameter failed against the first correction (`gc executed a configured Git hook`) and passes now. Assignments are shell-quoted with single quotes, so valid friendly names containing `=` (and quotes) are preserved. When no configuration hook is present, the environment is left untouched.

The regression configures a hook named `retention=extra` through an included file, verifies both the traditional and configuration hooks are active before collection on Git 2.54+, sets the inherited re-enable parameter, verifies neither hook runs during collection, and confirms the reference is actually deleted.

Git's [2.54 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.54.0.adoc) document configuration-defined hooks; the [hook configuration reference](https://git-scm.com/docs/git-config#Documentation/git-config.txt-hookltfriendly-namegtcommand) describes per-hook enablement.

## Validation

Base `ceabfccf466ab39fc80c274400bae5aa0744a227` (current `main`) with this patch applied. `HOME` and XDG directories were isolated.

- Git 2.54.0 (`/var/tmp/nexus-git-2.54.0`): retention hook, shell-injection and confinement tests **17/17 passed**, including the `retention=extra` hook and the inherited `GIT_CONFIG_PARAMETERS` re-enable case ([log](git254-current-tests.log)).
- Host Git 2.43.0: the same tests **17/17 passed** ([log](git243-current-tests.log)).
- Negative control: against the first correction that used only `GIT_CONFIG_COUNT`, the same test fails with `AssertionError: gc executed a configured Git hook` on Git 2.54; the current patch passes.
- `tsc --noEmit` and `git diff --check`: pass.

## Residual risk

- Configuration-defined hooks exist only on Git versions that support them; on older Git the `core.hooksPath` override remains the only control, as before.
- A malformed inherited `GIT_CONFIG_PARAMETERS` makes Git reject the config and the ref deletion is skipped (the cleanup `try/catch` keeps GC running); it cannot execute a hook, but the checkpoint record was already unlinked, so the ref is orphaned permanently. An orphan-ref sweep would be a separate improvement.
- The suppression helper is now shared with checkpoint create/prune/restore (`core/git_hook_guard.ts`); see `DEFECT-CONFIGURED-HOOKS-SHARED-20261027`.
- The shared guard and checkpoint coverage are recorded with a 34/34 run on Git 2.54 and 2.43 in `DEFECT-CONFIGURED-HOOKS-SHARED-20261027`. The full suite and release qualification were not part of this focused check; exact-head hosted CI covers integration.
