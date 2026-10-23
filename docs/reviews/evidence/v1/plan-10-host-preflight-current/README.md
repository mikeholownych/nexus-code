# Exact-source qualification-host preflight

## Disposition

`PASS` for the synthetic infrastructure preflight at source commit
`8f4504ebd3484149bde39b78934c193752a95bfd`. The full machine-readable report and
stdout are `validate-8f4504e.json` and `validate-8f4504e.log`; `SHA256SUMS`
binds both files.

## Scope

The preflight ran `eval/host/validate.mjs` from a clean worktree on `mike-dev`
with an isolated `HOME` and `XDG_CONFIG_HOME`. Its `--heldout` argument pointed
to a newly created root-owned directory containing only an empty synthetic
marker. The validator tested the operator-home and synthetic-store access
boundary, resource controls, cgroup containment and cleanup, Bubblewrap, and
fail-closed behavior. It did not access the custodian's held-out store, read any
task payload, invoke inference, or qualify an installed RC.

All 10 reported checks passed. The host had Bubblewrap 0.13.1, delegated cgroup
v2, and the dedicated 20 GiB tmpfs. The JSON report records the exact source
commit, resource profile, manifest digest, and all 16 source-file digests.

This result establishes the current host's synthetic infrastructure boundary
only. It does not establish held-out custody, evaluator authorization for the
private store, actual task-run Git-history isolation, task-quality thresholds,
or installed-RC qualification and acceptance.

## Refresh on current main

At `main@1f3c655971ade086f55347926db16cf2ecd52d1f`, the same infrastructure-only
preflight was repeated on `mike-dev` at `2026-10-23T13:57:05Z`. The `--heldout`
argument was a newly created root-owned synthetic directory containing only an
empty marker; the custodian store and all private corpus material were not
accessed. The isolated `HOME` and synthetic marker were removed after the run.
All 10 checks passed, including the 20 GiB tmpfs, cgroup resource controls,
process-tree cleanup, denied access to operator and synthetic-store files, and
fail-closed qualification preflight. The exact-source JSON and stdout are
`validate-1f3c655-20261023T135703Z.json` and `.log`; `SHA256SUMS` covers both
historical and refreshed evidence.

This refresh remains synthetic host-infrastructure evidence. It is not
custodian acceptance, a held-out run, or RC qualification.

## Refresh on main@a12c070

At `main@a12c07091f15f4e7d581907fab110b0653c4c264`, the same infrastructure-only
preflight was repeated on `mike-dev` at `2026-10-23T16:20:30Z`. The `--heldout`
argument pointed to a temporary root-owned directory containing only a
synthetic marker. The custodian store and private corpus were not accessed. The
isolated `HOME`, marker store, and detached source worktree were removed after
the run. All 10 checks passed, including resource enforcement, process-tree
cleanup, denied access to operator and synthetic-store files, fail-closed
preflight, and an empty evaluator workspace root. The exact-source JSON and
stdout are `validate-a12-20261023T162028Z.json` and `.log`; `SHA256SUMS` binds
both. This remains synthetic infrastructure evidence, not custody acceptance,
a held-out run, or RC qualification.

## Exact-source refresh on origin/main@92d7a62

At `origin/main@92d7a62f0fa20f4f2f3b91786c737fd6d5517075`, the same
infrastructure-only preflight ran on `mike-dev` at `2026-10-23T17:48:43Z`.
It used an isolated `HOME` and a temporary root-owned directory containing
only a synthetic marker; the custodian store and private corpus were not
accessed. All 10 checks passed. The report binds the exact source commit,
resource profile, 16 evaluator source-file digests, and manifest digest. Its
JSON and stdout are `validate-92d7-20261023T174843Z.json` and `.log`; both are
included in `SHA256SUMS`.

This establishes the synthetic host-infrastructure boundary at that time. It
does not establish custodian acceptance, private-store authorization, held-out
qualification, or installed-RC acceptance.
