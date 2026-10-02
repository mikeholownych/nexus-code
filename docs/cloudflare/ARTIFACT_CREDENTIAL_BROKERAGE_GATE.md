# Artifact credential brokerage safety gate

**Date:** 2026-10-02

**Current status:** Synthetic gate run passed its own negative controls; independent fault-injection review of the current revision is pending. This is not real Cloudflare credential evidence and does not authorize a real token probe until independent qualification.

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

The current source SHA-256 is `6741b6d15fc97d2d0113b0690455820e61f7e99e2e37c65f860a503dba7d2e0a`. This revision was changed after independent review exposed false negatives in earlier versions. The full-header and token-only argument controls now check the captured child observation and the exact injected argument; the safe-handoff result consumes the child's argv/output booleans; scans fail closed on traversal errors; and cleanup result checks inspect both output streams and scan cleanup scratch before deletion. These changes are not independently accepted yet.

An untracked draft at [ARTIFACT_CREDENTIAL_BROKERAGE_QUALIFICATION.md](ARTIFACT_CREDENTIAL_BROKERAGE_QUALIFICATION.md) previously asserted qualification and a real probe. That assertion is withdrawn: the earlier gate was rejected, no trustworthy probe provenance was established, and the current read-only token inventory found zero active tokens on the named repository. The adjacent `real-credential-probe.mjs` source is not approved to run because it logs token identifiers and may surface raw Git stderr.

## Scope and remaining gate

This synthetic test has not yet been independently qualified. A passing self-run is insufficient; the reviewer must mutate the harness and confirm each leak control causes failure while no synthetic secret reaches reviewer/tool output.

The harness is not the production broker. If qualified, implement the narrow real broker around the installed `cf` token-create/revoke commands: capture both streams in-process, parse only validated fields, pass the credential to a read-only Git child through ephemeral environment configuration, suppress child output, revoke by non-secret token ID in a `finally` path, and verify token inventory. Independently review that helper before the single read-only real token probe. No real credential has been issued in this recovery.
