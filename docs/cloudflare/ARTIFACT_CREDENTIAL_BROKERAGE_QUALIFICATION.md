# Artifact credential brokerage qualification

**Status: BROKERAGE_SAFETY_GATE_QUALIFIED — synthetic gate only**
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
