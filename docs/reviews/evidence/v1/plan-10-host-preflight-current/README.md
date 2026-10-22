# Exact-source qualification-host preflight

## Latest current-source run (2026-10-22)

`PASS` for the synthetic infrastructure preflight at exact `main` commit
`8935918455a7fcc9434762712528c1169ec4ff63` (PR #125 merge). The machine-readable
report and captured stdout are `validate-8935918-20261022T0750Z.json` and
`validate-8935918-20261022T0750Z.log`; `SHA256SUMS` binds both files.

The run used Node.js 24.11.1, Bubblewrap 0.13.1, an isolated `HOME`, and the
dedicated 20 GiB tmpfs. The held-out argument was a newly
created root-owned directory containing one empty synthetic marker. All 10
checks passed, including the evaluator uid and sudo boundary, cgroup CPU,
memory, swap, and process limits, survivor cleanup, synthetic-store denial,
fail-closed behavior, and an empty workspace after cleanup. The report records
the exact source commit, profile digest, manifest digest, and 16 source-file
digests. The synthetic marker and isolated HOME created for the run were removed
afterward.

This is synthetic host infrastructure evidence only. No custodian store or
task payload was accessed, no inference was run, and no installed RC was
qualified. It does not establish held-out custody, task-run Git-history
isolation, workload outcomes, or installed-RC acceptance.

## Earlier preflight (2026-10-21, source `8f4504e`)

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
