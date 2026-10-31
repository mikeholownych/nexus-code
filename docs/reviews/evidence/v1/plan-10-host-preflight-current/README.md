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
