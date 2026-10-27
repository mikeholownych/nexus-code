# Exact-source evaluator host preflight on `ceabfcc`

## Disposition

`PASS` for the synthetic host-infrastructure preflight: all 10 checks passed on `mike-dev` at exact source `ceabfccf466ab39fc80c274400bae5aa0744a227`. The machine-readable report and validator output are `validate-ceabfcc-20261027T165220Z.json` and `.log`. `runtime-identity.txt` records the host, boot identity, observation time, Node runtime, and source commit. `SHA256SUMS` binds these files and this report.

## Scope and limits

The validator ran from a dedicated worktree at `ceabfcc`, with an isolated `HOME` and `XDG_CONFIG_HOME`. Its `--heldout` argument pointed only to a temporary root-owned directory containing one empty synthetic canary. The real custodian store was not passed to the validator, opened, or read; no held-out payload, validator, inference gateway, or provider was accessed. The temporary canary directory was removed after the run.

This proves the synthetic infrastructure checks observed on this host and exact source revision. It does not establish evaluator custody, custodian authorization, corpus integrity or quality, a held-out run, M5 qualification, or installed-RC acceptance. The validator report's `revision.dirty` field checks tracked files only; the generated evidence files were untracked outputs during the run.

## Observed results

- Evaluator account UID 985 is separate and has the `nologin` shell.
- The restricted sudo rule permits the harness's Bubblewrap invocation and rejects the tested broader commands.
- Bubblewrap 0.13.1 and `setfacl` are available.
- `/srv/nexus-qual/ws` is an operator-owned 20 GiB tmpfs.
- Resource enforcement and cleanup passed: memory max 16 GiB, swap max 0, process limit 4096, CPU quota 800000/100000, and one evaluator-owned survivor was reaped.
- Operator-home and synthetic-store access were denied to the evaluator.
- Qualification preflight failed closed without controls, and no run directories remained in the workspace root.

The report binds the exact commit, resource profile digest, public manifest digest, and digests for all evaluator source files covered by the validator.
