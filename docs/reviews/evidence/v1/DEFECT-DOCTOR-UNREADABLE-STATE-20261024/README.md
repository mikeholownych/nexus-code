# DEFECT: doctor reports an unreadable state store as healthy

| | |
|---|---|
| Base revision | `0a80759de65d2d6909d1d259d1cbd11c5b9321f5` (`origin/main`) |
| Branch | `v1/defect-doctor-unreadable-state` |
| Affected behavior | `stateIntegrityCheck` caught every `newestStateFiles` failure (permission denied, path is not a directory) and continued. With no files counted and no temporary files, it returned `pass: No saved sessions or task state yet.` An existing but unreadable state store was therefore reported healthy. |
| Severity | Medium-low: a truthfulness defect in the diagnostic operator's tool. It can hide a permissions/type problem and discourage investigation of unreadable sessions or task state. |

## Reproduction (pre-fix)

```
home/.nexus/sessions   (mode 000, tasks absent)
runDoctor({ home })
-> state.integrity: pass "No saved sessions or task state yet."
```

Replacing `.nexus/tasks` with a regular file (ENOTDIR) produced the same false pass.

## Fix

Distinguish ENOENT (legitimately empty) from other open errors. Track unreadable state directories
and report `warn` with the affected paths and a permissions/type advice; a missing store still returns
the empty pass. The existing corrupt-record and temporary-file warnings are unchanged, and their
evidence keeps its bounded list.

## Verification

- New tests fail on the pre-fix source and pass now:
  - `state integrity warns when a state directory cannot be read` (skipped as root, which ignores mode 000);
  - `state integrity warns when a state path is not a directory`.
- All eight `state integrity` doctor tests pass with isolated `HOME`.
- `npx tsc --noEmit -p tsconfig.json`: pass; `git diff --check`: pass.
- The full `doctor.test.ts` file also has pre-existing environment-prerequisite failures in this fresh
  worktree (no built `cli/dist` / `nexus-tui` / launcher); those are not counted as a pass and are not
  attributed to this change.
