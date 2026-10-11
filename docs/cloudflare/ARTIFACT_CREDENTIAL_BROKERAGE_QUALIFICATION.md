# Artifact credential brokerage qualification

**Historical status (superseded): BROKERAGE_SAFETY_GATE_QUALIFIED — synthetic detector matrix only.**
**Current status: BROKERAGE_SAFETY_GATE_NOT_QUALIFIED.**
**Date:** 2026-10-02

## Independent gate result

The independent reviewer tested source SHA-256
`6741b6d15fc97d2d0113b0690455820e61f7e99e2e37c65f860a503dba7d2e0a` with a
successful baseline and 25 synthetic fault injections. All 25 faults were
rejected; captured final output remained free of the canary. This qualifies
only the detector matrix exercised by that reviewer. It does not qualify the
production credential broker or prove Cloudflare credential behavior.

## Withdrawn, unverified draft assertion

An earlier untracked version of this document claimed both that the broker was
qualified and that a live real-credential probe had occurred. That claim is
withdrawn. The prior gate review had rejected the gate, and no trustworthy
provenance for that claimed probe was established. A current read-only
inventory for `nexus-exp1-oct02/external-git-proof` returned zero active
tokens; this does not establish whether the claimed historical operation
occurred. No real credential was issued in the recovery turn before synthetic
gate qualification.

The existing `credential-broker.mjs` and `real-credential-probe.mjs` are not
approved to run. Source review found that the probe prints token identifiers
and may surface raw Git stderr. A separate, minimal broker must be independently
reviewed before any real credential probe.

## Authorization boundary

The synthetic safety gate's independent qualification satisfies only the
canary-gate prerequisite. It is not authorization to bypass review of the
actual broker. The one real read-only credential probe may proceed only after
the corrected broker is reviewed for output, argv, persistence, error,
revocation, and failure-path handling. The stale-interface Experiment 3
iteration remains blocked until that probe independently qualifies.

## Corrected helper synthetic run

Source SHA-256:

- `credential-probe-safe.mjs`: `7e4c7aac6eb369779db318907a920f7facc3730cbc068bdd0fb3a75e68eca6ff`
- `credential-probe-safe-test.mjs`: `75c75569b52206f4ee23c5f06c3321d3338786c33d89e3a96b7d45848d421263`

The fake CLI/Git run covered ten cases: exact synthetic credential handoff;
issuer stderr reflection; nonzero issuance after server-side creation; missing
ID; Git stdout, stderr, and scratch-file reflection; failed revocation; an
argv-guard injection; and SIGTERM during Git work. Each case produced the
expected fail-closed or success result. The normal case verified the fake Git
child received the exact canary in the ephemeral header; argv checks came from
the fake CLI/Git child observations. Final test output, argv, and retained
fixture files contained no canary. The test also supplied the installed real
`cf` and `/usr/bin/git` paths in synthetic mode, a symlink to the installed
`cf` named like the permitted fake, and a wrapper executable; the helper
rejected all before invocation. Invocation without an explicit mode was also
rejected before any command. The fake programs are pinned by SHA-256 and the
helper checks regular-file and canonical-path identity. The baseline-success and SIGTERM cases
require an observed exact credential handoff, and the SIGTERM case also
requires an observed child argv check. No Cloudflare calls occurred.

Limits: the missing-ID and failed-revocation synthetic cases leave the fake
token active and report failure; source requests a 300-second TTL but the test
does not demonstrate service-side expiry. SIGTERM cleanup was exercised; an
uncatchable SIGKILL/power loss remains bounded only by the service TTL and is
not empirically tested here. Prior independent reviews found omitted handoff
and SIGTERM observations, then synthetic dispatch gaps. The current helper
requires explicit mode selection, pins the harmless fake program hashes,
rejects direct real paths, symlinks, and wrappers, strips inherited environment
from synthetic CLI calls, and the local synthetic suite passes. The latest
independent review still returned **REAL_CREDENTIAL_PROBE_GATE_NOT_QUALIFIED**:
the validated Git path differs from the path later executed, and the checked
file can be replaced between validation and execution. It also found that
ambiguous issuance/revocation failure can leave a live token; the requested
300-second TTL is unverified, and inventory absence is not proof that revoked
credentials fail at the Git endpoint. Do not issue a real credential.

## Superseding recovery review

The source hashes and review findings above describe the earlier helper and
are historical. The current helper now uses an inherited executable
descriptor and explicit credential lifecycle reducer. Its synthetic suite
covers output and argv reflection, synthetic persistence to scratch files,
Git-config/remote/evidence/environment persistence, abnormal child exit,
ambiguous issuance, failed revocation, and SIGTERM. The suite passes its
synthetic negative controls; that does not qualify production trust or
Cloudflare behavior.

The fresh independent review returns
`BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`. It found that descriptor execution does
not prevent in-place modification of the opened inode; the ELF fixture does
not qualify the `cf` shebang/interpreter and runtime chain; post-revocation
Git output is not scanned for credential reflection; and an exception from a
cleanup scan can bypass later scratch/lock cleanup. The configured `cf`
target is a UID-1000 shebang script with mode `0775`, so the current trust
policy rejects it before running it. No real credential was issued and no
Cloudflare mutation occurred. The requested TTL metadata is not empirical
proof of expiry enforcement. Refer to the
[superseding security record](BROKERAGE_SECURITY_SUPERSESSION_2026-10-02.md)
for current scope and next gates.
