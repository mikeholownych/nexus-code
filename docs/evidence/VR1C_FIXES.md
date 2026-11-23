# VR1C_FIXES — PR #732 owner-review follow-up

Worktree: `VR1C_FIXES`. Target: `release/v1.3.0`. PR: <https://github.com/mikeholownych/nexus-code/pull/732>.
Owner review head: `9580dab0a6ccb75bfe2ae00445b825694129023b`. No merge, tag or publish was performed here.

## Owner findings and disposition

1. **Outside-checkout visibility** — fixed. `sandboxedVerifierCommand` accepts `maskDirs`; `verifyChange` resolves the worktree and, where possible, `--git-common-dir`, and covers both with a private tmpfs before binding dependency directories read-only. Regression: `verify_hostile` “cannot read the caller's checkout by absolute path” with a repository under `/var/tmp`, plus the bwrap composition assertion in `verify_sandbox`.
2. **Ignored `link`/`rename`** — fixed. The trace parser records the source path of `link`, `linkat`, `rename`, `renameat`, `renameat2`, `symlink` and `symlinkat` as a successful observation. Regression: hard link to the baseline oracle followed by a read lowers the verdict and emits `testFixtureReads`.
3. **Static changed-JS/TS gate** — removed. Candidate-only successful observations of oracle paths lower the verdict in every language and however the filesystem handle is obtained. Regressions cover `process.getBuiltinModule("f"+"s")`, a computed directory listing, an escaped module name, and non-JS product files.
4. **Honest fixes losing `VERIFIED`** — fixed. Runner-owned paths (`.`, `node_modules/`, `.git/`) and failed lookups are excluded; the test-side regex requires an actual read/subprocess/dynamic-import call; head-only test files and their parent directories are excluded from candidate-only counting; the narrow ambiguity rule remains for ordinary workspace files such as `package.json`. Regressions cover a test importing `node:fs` without reading it, an added import causing one extra `src/package.json` lookup, a fix reading its own data file, and an unrelated directory symlink.
5. **Hostile-suite cost / 2,000-file case** — fixed. The product bound stays `MAX_TEST_FILES` and is exercised by `discoverWorkspaceTestFiles`; the end-to-end hostile case now uses the operator-only `testFileLimit` override (clamped to `1..MAX_TEST_FILES`) with eight files. Node 22 hostile suite: 46/46.
6. **Directory symlinks and stale messages** — fixed. Walking follows directory symlinks with a realpath cycle guard; only escaping links, test-file links or unreadable targets fail closed. `agent.ts` and `independent_check.ts` now say the test set could not be captured completely.
7. **`/proc/self/task/<tid>/cwd`** — fixed. The alias resolver handles the numeric task form and maps it to the recorded cwd; regression lowers the verdict for a filename existence probe through that spelling.
8. **Dead `clone`/`fork`/`fchdir` branches** — made live. The strace request explicitly includes `%process`, `getdents`, `getdents64`, `chdir` and `fchdir`; `chdir` and `fchdir` update per-pid cwd state. Interleaved `<unfinished ...>` / `<... resumed>` lines are now stitched by pid and syscall, which removed the intermittent Node 24 losses seen before this fix.
9. **Runner re-reads, ptrace denial and unbounded trace** — addressed. The equal-count ambiguity rule treats a non-test workspace file as ambiguous when test code can read it by a computed path. A trace larger than `MAX_FILE_TRACE_BYTES = 32 * 1024 * 1024` fails closed, is deleted after parsing, and is never read whole past that bound. Ptrace denial still surfaces through the existing `SANDBOX_UNAVAILABLE`/trace-unavailable path rather than a false `VERIFIED`.
10. **Minor findings** — fixed. `workspaceTestFiles` was removed; the bogus first schema ledger entry was replaced by the coordinated v3 ledger; tests now check the fixed strace path rather than `PATH`; the symlink/bwrap tests assert more than one fact.

## Claims corrected

- Removed “Equal or higher baseline counts can no longer mask candidate access”: the ambiguity rule is intentionally narrow and covers ordinary non-test workspace files such as `package.json` when test code can read them.
- Removed “no remaining straightforward forgery path”; `docs/VERIFY_IN_CI.md` now states the remaining trust boundary and the cost of the traced run.
- Restored the limitation that a hard-coded expected value is undetectable.
- `docs/USER_MANUAL.md` no longer claims the checkout is merely read-only; it now says the checkout and its Git common directory are covered before dependency binds, even outside HOME and `/tmp`.

## Protocol coordination with PR #737

PR #737 owns the v3 review contract (`fc7c244dc06ee35679862821d864441677ce8f4f0ba07d8de065186f71e32ef9`). This branch keeps that v3 shape and appends one additive ledger entry for optional `runs[].testFixtureReads`. The regenerated schema hash is `7e976e86d37f9e991ae3162ccb5d0359ca04b36f335fd531303b979ac5da6f36`; `node cli/scripts/gen_verify_result_schema.mjs --check` passes. No #737 review implementation was copied into this branch.

## Measured gates

Every TypeScript invocation used a throwaway `HOME`. Build and typecheck passed; `git diff --check` passed.

| Test file | Node 22 | Node 24 |
| --- | --- | --- |
| `verify_hostile` | 46/46 | 46/46 |
| `verify_sandbox` | 9/9 | 9/9 |
| `verification_outcome` | 3/3 | 3/3 |
| `verify_command` | 18/18 | 18/18 |
| `verify_schema` | 4/4 | 4/4 |
| `verify_typecheck_guard` | 13/13 | 13/13 |
| `verify_action` | 9/9 | 9/9 |
| `tester_redos` | 2/2 | 2/2 |
| `review_unit_boundary` | 24/24 | 24/24 |
| `independent_verification` | 17/34 | 17/34 |
| `verification_binding` | 4/5 | 4/5 |
| `verifier_gating` | 4/8 | 4/8 |
| `repro_false_verified` | 0/2 | 0/2 |

The last four suites fail identically with this branch's changes stashed; they are pre-existing host/fixture failures, not regressions from this work. The hostile suite was run three consecutive times on each Node version after stitching unfinished/resumed syscalls, and twice more after the test-only fixed-strace-path correction: 46/46 on every run. CI remains the arbiter; fresh hosted checks are required for the new head.

## Reference coding

XERJ was queried locally before the non-trivial parser and sandbox changes.

- **TAKEN:** the `r2r-enforce` rule that an unmet evidence boundary is reported explicitly instead of inferring completion from a later observation (`r2r-jev/SECURITY.md:43`, `r2r-jev/docs/verification-readiness.md:31`, `r2r-jev/docs/r2r-mcp-prototype.md:247`, `r2r-jev/CONTRIBUTING.md:1`). Applied as fail-closed trace/discovery errors, never as a way for a reviewer to raise a verdict.
- **TAKEN:** the OpenBSD least-visibility principle behind `unveil` (`openbsd-faq/papers/eurobsdcon2018-unveil/mgp00008.txt:2`, `openbsd-faq/papers/fosdem2023-gotd.pdf`, `openbsd-faq/71.html:315`). Applied by masking the worktree and Git common dir before dependency binds and by using a private scratch tree.
- **REJECTED:** `glasskube`'s retry/reconcile-to-convergence pattern: an ambiguous or incomplete verification needs an operator decision, not another attempt.
- No reference code was copied. `xerj feedback --dry-run` was inspected, but publication failed: pushing the prepared field-report branch to `xerj-fork` could not read a GitHub username because terminal prompts are disabled. The temporary local branch was removed; no field report was submitted.

## Remaining qualification

This change proves only the configured test suite, not full specification coverage. It still depends on the sandbox engine and on host `strace` under Bubblewrap; Docker-only and non-Linux hosts reach `VERIFIED` only with the explicit trust opt-out `--sandbox none`. No frontier-grade claim is made: hosted checks are pending and CI is the arbiter.
