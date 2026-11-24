# PA-2 verified merge arbitration

Status: **implemented on branch `v1/pa2-verified-merges`; tested locally, not yet through CI or external qualification.**

## Contract

Applies to durable operations with `"git": { "isolate": true }` (`nexus operation run`, `/batch`, `/team`): each unit works on its own worktree and branch, and completions merge one at a time into the operation branch. `/loop` and `/goal` drive one workspace and produce no merge, so they are outside this unit.

After each merge, before the receipt is written, the runner checks the **merged tree** with every verifier that already holds on the operation branch:

1. the operator's verifier (`--authoritative-verifier`), pinned in the operation record (`git.integrationVerifiers`) when the operation runs. A resume started with another verifier adds it; one started with none drops nothing;
2. the integrating unit's own verifier, when it passed with executed tests;
3. the verifier of every unit integrated earlier, in merge order.

Identical command strings run once. At most **16** distinct commands run per merge. A seventeenth refuses the integration before anything is merged: no check is skipped and no result is called verified with a check left out.

The checks run in order and stop at the first that does not pass. The merge is then undone (the operation branch and its worktree are put back on the pre-merge commit) and the unit blocks with a decision:

| What failed | What the runner does | Decision |
|---|---|---|
| A check owned by the operator or an earlier unit | Runs that one check again on the pre-merge tree. It passes there: the merge broke it (`baseline: PASSED`). | `INTEGRATION_FAILED`, names the refused unit, the units whose verifier broke and the command |
| The same, but it fails on the pre-merge tree too | The branch or its environment was already broken (`baseline: FAILED`). The unit is not blamed and is still not integrated, because the merged tree cannot be verified. | `INTEGRATION_FAILED`, "not attributed to" the unit |
| The unit's own verifier | It passed in the unit's worktree, so the difference is integrated work the unit had not seen: those units are named. No pre-merge run (the unit's tests are not in that tree). | `INTEGRATION_FAILED` |
| The command cannot start (exit 126/127), or the sandbox cannot be built | Nothing is attributed. | `INTEGRATION_FAILED` |
| Git reports a textual conflict | The merge is aborted, as before; the integrated units that changed the conflicted files are named. | `MERGE_CONFLICT` |

Every refusal also records an `INTEGRATION_REJECTED` event (`detail: { unitId, conflictWith, checks | files }`). The options are retry and revise (and stop). A passing merge records `mergedChecks` on the receipt and the `WORK_INTEGRATED` event says how many checks passed. With no verifier at all the receipt says `NOT_RUN` and the event says "not re-verified", as before.

"Neither is integrated silently" therefore means: integration is serialized, the first unit lands with a recorded check result, and the second is refused with a decision naming both. No unit is integrated without a recorded result, and none after failing a check.

## Verification files of integrated work

A merge that changes a verification file which earlier integrated work added or changed is refused **before any check runs**: otherwise a unit could weaken another unit's test and then pass that unit's check. "Verification file" is decided by `SecurityManager.classifyVerificationPath` (the classifier behind the agent's edit gate and `nexus verify`): runnable test files, test configuration, verifier scripts, CI and build files, `package.json`, `.nexus-security.json`, plus the operator's `verificationPaths.extra`. The policy is read from the operator's checkout, never from a tree a unit wrote. The file lists come from Git objects (NUL-separated, pinned options), so an oddly named file cannot hide.

## Confinement

A merged-tree check runs the way the session runs its units' commands:

- With a sandbox configured (`--sandbox`, or managed policy `sandbox.required`) the check runs in that engine through the wrapper `nexus verify` uses (`sandboxedVerifierCommand`): read-only host, masked HOME, private `/tmp`, the verifier's environment allowlist, network only when the operator enabled it for the sandbox. Only the integration worktree is writable; the operation's other worktrees are hidden. A sandbox that cannot be built fails the integration. The command is never run on the host instead.
- With no sandbox configured, the check runs on the host with the verifier's scrubbed environment and deadline, as the unit's own verifier and the earlier single-verifier integration check did.

Host-side Git in a unit's worktree and in the integration worktree runs against the verified Git directory (`trustedGitArgs`). A worktree whose `.git` pointer was replaced is refused.

## Who writes the record

`mergedChecks`, the receipt and `INTEGRATION_REJECTED` are written by the runner from processes it started. A unit's result text, extra fields on its result and files in its worktree are not read for them. Integration never raises a unit's outcome: the turn-level VERIFIED ladder, approval gates, verification-path protection and managed policy are unchanged.

## Compatibility

Operation document version **6**. Versions 1 to 5 load by changing the version alone (after the `.pre-migration-v<N>` copy); nothing is pinned or re-checked after the fact. Version 5 added detached-job `origin`; version 6 adds PA-2 merged-verification evidence. A version-5 build refuses a version-6 record, so it cannot resume one and integrate without the cumulative checks. Damaged `git.integrationVerifiers` or `mergedChecks` are refused at load.

## Not covered

- An operation run without `--sandbox` runs merged-tree checks on the host. Use `--sandbox` (or require it by policy) for untrusted work.
- A dependent unit that legitimately extends a test file an earlier unit integrated is refused by the verification-file rule; there is no accept option. Put such changes in the unit that owns the test, or revise the unit.
- Verification files that were already in the operation's base are not covered by that rule; the agent-side verification-path gate governs them.
- On the crash path (the merge was already in place when the runner restarted) the checks and the verification-file rule run, but a failure does not undo the merge: it is reported for the operator, as before.
- An unstable verifier blocks later units as "not attributable". No automatic re-ordering, retry or bisection of units.
- Attribution names units, not lines: with more than two units the named set is "integrated work the unit had not seen".
- The `--dag --json` view document is unchanged (schema 2); the rejection appears there as an event and an open decision, and the checks in `nexus operation status --json`.
- No live-model evidence and no external qualification.

## Verification record

`cli/test/operation_merged_checks.test.ts` (the Git primitive) and `cli/test/operation_semantic_conflict.test.ts` (runner, record version, example spec). Real temporary Git repositories and real verifier processes; a scripted executor; no model and no network. Each guard was removed in turn to confirm a test fails without it.
