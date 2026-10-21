# Exact-source qualification-host preflight

## Disposition

`PASS` for the current integration source commit
`7d6673f108316dda015b858c85b2abe20f3a4f78`. The current machine-readable report
and stdout are `validate-7d6673f.json` and `validate-7d6673f.log`. The earlier
`8f4504e` report is retained as historical evidence. `SHA256SUMS` binds all four
report and log files.

## Scope

The current preflight ran `eval/host/validate.mjs` from a clean worktree at
`7d6673f` on `mike-dev`, with isolated `HOME` and `XDG_CONFIG_HOME`. Its
`--heldout` argument pointed to a newly created root-owned directory containing
only an empty synthetic marker. The validator tested the operator-home and
synthetic-store access boundary, resource controls, cgroup containment and
cleanup, Bubblewrap, and fail-closed behavior. It did not access the custodian's
held-out store, read any task payload, invoke inference, or qualify an installed
RC.

All 10 current checks passed. The host had Bubblewrap 0.13.1, delegated cgroup
v2, and the dedicated 20 GiB tmpfs. The JSON report records the exact source
commit, resource profile, manifest digest, and all 16 source-file digests.

This result establishes the current host's synthetic infrastructure boundary
only. It does not establish held-out custody, evaluator authorization for the
private store, actual task-run Git-history isolation, task-quality thresholds,
or installed-RC qualification and acceptance.
