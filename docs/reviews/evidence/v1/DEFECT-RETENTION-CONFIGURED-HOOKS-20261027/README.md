# Retention cleanup: Git configuration-defined hook suppression

## Finding and correction

PR #269 disables traditional repository hook scripts with `core.hooksPath=/dev/null`. Git 2.54 added named hooks defined in configuration, and those hooks are not disabled by `core.hooksPath`. The first 2.54 regression attempt confirmed that `reference-transaction` configuration hooks still ran during checkpoint ref deletion, even with `hook.reference-transaction.enabled=false` supplied on the command line. Git 2.54's per-hook `hook.<name>.enabled` setting is the compatible control.

The correction reads effective `hook.*.event` entries, including config includes, finds each configured `reference-transaction` hook, and supplies `hook.<name>.enabled=false` as separate `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` environment entries for the ref-deletion command. Separate key/value fields safely preserve every valid friendly name, including names containing `=`. Existing command-scope entries are retained and the cleanup overrides are appended at higher precedence. Traditional hooks remain disabled with the fixed command-line `core.hooksPath=/dev/null` override, preserving compatibility with Git versions older than 2.31. The regression configures a hook named `retention=extra` through an included file and verifies both hook types are active before collection on Git 2.54+, neither runs during collection, and the reference is actually deleted.

Git's [2.54 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.54.0.adoc) document configuration-defined hooks; the [hook configuration reference](https://git-scm.com/docs/git-config#Documentation/git-config.txt-hookltfriendly-namegtcommand) describes per-hook enablement.

## Validation

The isolated verification snapshot was based on `b006c1dd3f00f6ff17af38360baefb6fa30efa81` with the candidate patch applied (updated source-and-test diff SHA-256 `05ad34b54ba1f5f6698a1c46b774b9ec88e29d53edfb62549ef32a6865dc1b14`). `HOME` and XDG directories were isolated.

- Git 2.54.0, built under `/var/tmp/nexus-git-2.54.0`: retention hook, confinement, and shell-injection tests **17/17 passed**, including the `retention=extra` hook name; `tsc --noEmit` passed.
- Host Git 2.43.0: the same tests **17/17 passed**; `tsc --noEmit` passed.
- Negative-control run on Git 2.54.0 using PR #269's original `retention.ts` and the included-file hook regression: the configured hook marker appeared during GC and the regression failed, as expected.
- `git diff --check` passed.

Raw test outputs are preserved alongside this report: [Git 2.54 tests](git254-equals-tests.log), [Git 2.43 tests](git243-equals-tests.log), plus the earlier [Git 2.54 simple-name tests](git254-tests.log), [Git 2.43 simple-name tests](git243-tests.log), and the [Git 2.54 negative control](git254-negative-control.log). The updated TypeScript check completed with exit 0 and no diagnostic output ([updated check](tsc-equals.log); earlier checks: [Git 2.54](git254-tsc.log), [Git 2.43](git243-tsc.log)). The full suite and release qualification were not run as part of this focused check. Independent re-review, current-main rebase, exact-head CI, and integration remain pending.
