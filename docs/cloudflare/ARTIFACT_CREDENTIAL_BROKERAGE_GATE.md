# Artifact credential brokerage safety gate

**Date:** 2026-10-02

**Current status:** `BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`. The earlier synthetic-only qualification claim is superseded by later adversarial findings. No real credential operation is authorized.

## Previous harness rejection

The prior `token-broker-canary.mjs` is rejected. Independent mutation tests found that it incorrectly passed when the final stdout contained the canary, malformed issuer stderr was forwarded, a token-only argument was used, or the synthetic token ID was missing. Root causes were assertions against a constructed summary rather than captured output, checking the full authorization header rather than the token substring, cleanup success represented by assigning the supplied ID, and calling environment/digest delivery proof of authenticated Git transport.

The old harness has not been used for this gate.

## Corrected synthetic gate

Source: [brokerage-safety-gate.mjs](../../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/brokerage-safety-gate.mjs).

The parent process generates a synthetic random value, launches isolated child modes, captures stdout and stderr before they can reach the tool boundary, scans controlled scratch/evidence/Git config files, checks child argv, and emits only a boolean summary. All intentional channel leaks are synthetic and captured in memory or written under a temporary directory removed in `finally`.

The safe handoff scenario sends the synthetic authorization header only through process-local Git configuration environment to a child process. A digest comparison verifies child receipt without printing the value. This establishes local process handoff only; it does not establish real Artifacts authentication, Cloudflare revocation, or a real network Git operation.

### Run result

- Harness exit: 0; `gatePassed: true`.
- Safe child receipt: true; child/outer captured output and argv clean; isolated local/global config and credential-free remote clean.
- Negative controls detected: stdout, stderr, full-header argv, token-only argv, environment persistence file, temporary file, evidence file, remote URL, local Git config, global Git config.
- Failure controls detected: failed revoke result, missing synthetic token ID, abnormal child termination with parent cleanup hook.
- Scratch cleanup: true; final evidence contains no canary.
- Cloudflare API or credential operations: none.

The independent reviewer ran a baseline plus 25 fault injections against source SHA-256 `6741b6d15fc97d2d0113b0690455820e61f7e99e2e37c65f860a503dba7d2e0a`. All 25 faults were rejected, including cleanup scratch-file leakage; all captured outputs were canary-free. This qualifies the synthetic detector matrix only.

An untracked draft at [ARTIFACT_CREDENTIAL_BROKERAGE_QUALIFICATION.md](ARTIFACT_CREDENTIAL_BROKERAGE_QUALIFICATION.md) previously asserted qualification and a real probe. That assertion is withdrawn: the earlier gate was rejected, no trustworthy probe provenance was established, and the current read-only token inventory found zero active tokens on the named repository. The adjacent `real-credential-probe.mjs` source is not approved to run because it logs token identifiers and may surface raw Git stderr.

## Safe probe helper test

The new safe probe helper and fake CLI/Git harness have also been run locally with ten synthetic cases: baseline success, issuer stderr reflection, nonzero issuance after creation, missing token ID, Git stdout/stderr/file reflection, revocation failure, Git argv guard injection, and SIGTERM during Git work. The harness reported the expected result for each case and found no canary in captured output, argv, or retained fixture files. The missing-ID and revoke-failure cases intentionally report active fake credentials and failure; the TTL parameter was only requested, not observed to expire. Source hashes and limits are recorded in `ARTIFACT_CREDENTIAL_BROKERAGE_QUALIFICATION.md`. Independent review of these exact two files is pending; no Cloudflare operation occurred.

Independent review then found the helper's synthetic mode accepted arbitrary CLI paths, including authenticated `cf`, and invocation without a mode defaulted to live operations. The helper now requires explicit mode selection, confines synthetic executable paths to the isolated test directory, removes inherited environment from synthetic CLI invocations, and the test checks rejection of both real executable paths and implicit live mode. These corrected hashes still require independent review; the real credential gate remains unqualified.

The subsequent exact-hash review found the Git path validated is not necessarily the path executed, and the validated pathname can be replaced before execution. Ambiguous issuance/revocation, TTL enforcement, and authentication rejection after revocation also remain unproven. See [superseding security record](BROKERAGE_SECURITY_SUPERSESSION_2026-10-02.md). The earlier synthetic matrix result is historical, not current gate qualification.

The test harness is not proof of actual Cloudflare authentication or token lifecycle. Do not issue a real credential until the helper is independently reviewed for output, argv, persistence, error, revocation, and failure-path handling. No real credential has been issued in this recovery turn.

## 2026-10-02 superseding source review

The current helper and its expanded synthetic test include descriptor-bound
launch, explicit lifecycle states, persistence fault injection with write
witnesses, and a post-revocation output-reflection control. The latest
independent source review still does not qualify real brokerage: an open inode
may be modified in place, the ELF-only test does not qualify the configured
`cf` shebang/interpreter chain, and the current `cf` target (UID 1000, mode
`0775`) is correctly rejected by the trust policy. The configured `cf` digest
is not pinned. TTL enforcement and live credential lifecycle remain untested.
The latest bounded snapshot evidence also cannot establish exact-match absence
because the revoked plaintext literal was not retained and the stale transcript
descriptor remains append-open. Current status remains
`BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`; no real Artifact credential issuance is
authorized.
