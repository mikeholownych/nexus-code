# RC11 installed scripted PTY evidence

This packet preserves selected raw outputs and scripts from the installed-package run against `v1.0.0-rc.11`. It is evidence for acceptance §5.2 only. It does not establish whole-RC acceptance.

- Tag: `v1.0.0-rc.11`
- Source commit: `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`
- Installed package SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`
- Scenario environment: mike-dev, Linux x86_64, Node 24.11.1, Python 3.12.3, pyte 0.8.2, synthetic PTYs, loopback mock gateway, isolated HOME/XDG and synthetic workspaces.
- Qualification used no real provider, credentials, held-out tasks, or user workspace.

`RC11-SCRIPTED-RESULTS.md` is the run report. `RECOVERY-STATUS-20261030.md` explains the corrected s1 completion predicate and retained rerun. `raw/` contains selected run scripts, raw terminal streams, screen captures, mock-gateway records, and s1 task/session receipts. `raw/s5-cancel-ack-timing/` preserves a timestamped 3-trial rerun that observed the cancellation state within a 16.667ms 60Hz frame budget and idle within 5s against the exact installed artifact.

## Integrity reconciliation

The source run directory's RC11-specific index (`RC11-SCRIPTED-SHA256SUMS`, SHA-256 `5bac85a0f2b094acea0ece828f45b9e9d39b6572eec0c00fada0a12f31dc14bc`) verified 959 entries before curation. The source directory's separate legacy `SHA256SUMS` index was stale: 57 mismatches and 245 missing paths. That legacy index is excluded and is not authoritative. The `SHA256SUMS` files included in this packet are newly generated curated indexes; they cover only files tracked in this packet, not ignored local run logs. The source's two s1 sub-run manifests also verified before curation. The embedded synthetic workspaces' `.git` stores and Python bytecode caches are excluded from this public packet; no held-out store or solution content was accessed.

The initial s1 attempt was interrupted and is retained as an incomplete attempt. The later asserted s1 run is the result used for the criterion. The original s9 probe did not establish process cleanup; the corrected named-survivor probe and three raw reruns are retained instead. The overall runner exit status was not retained, so no result is inferred from it.

## Disposition

Observed outcomes are recorded per criterion, with incomplete attempts preserved. Independent review of this archived packet is pending. Until that review accepts the exact packet and the evidence is integrated, §5.2 remains pending. The §5.3 manual terminal matrix is waived for v1.0.0 by DEC-20; §5.1 remains mandatory.
