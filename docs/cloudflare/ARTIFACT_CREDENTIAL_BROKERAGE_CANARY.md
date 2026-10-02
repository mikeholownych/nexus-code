# Artifact Credential Brokerage Canary

**Status:** Synthetic-only experiment is **not accepted as a safe brokerage test**. A baseline run passed its self-reported checks, but independent mutation testing found false-negative assertions. No real Artifact credential was created.
**Date:** 2026-10-02

## Selected pattern

A local Node process invokes `cf artifacts namespaces tokens create` as a child, captures both stdout and stderr in memory, parses and validates the result without forwarding it, and supplies the token only to the ordinary Git child through a process-local `GIT_CONFIG_VALUE_0` HTTP header. Git stdout/stderr must also be captured and suppressed or reduced to secret-free status fields. The parent then invokes token revocation in a `finally` path, verifies repository token inventory, and fails closed if creation, parsing, Git, or revocation is uncertain. Do not use the direct interactive command for token creation.

Cloudflare documents the token-create response as containing the one-time plaintext token. The current `cf` CLI prints structured API results as JSON to stdout, and its installed Artifacts handler does not redact the token field. That is expected API data handled unsafely by a direct-to-transcript invocation. See [Cloudflare Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/) and the installed CLI 1.0.0-beta.10 source described in the independent incident review.

## Synthetic test

The reproducible harness is [token-broker-canary.mjs](../../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/token-broker-canary.mjs). It generates a random synthetic value in process memory and models a token-create response. It does not call Cloudflare.

**OBSERVED:** the unmodified harness returned exit 0 and zero self-reported failed checks. Independent adversarial mutation testing then falsified its output/argument/cleanup assertions:

- mutation: canary appended to final stdout — harness incorrectly passed;
- mutation: malformed issuer stderr forwarded — harness incorrectly passed;
- mutation: token alone passed in child argv — harness incorrectly reported argv clean;
- mutation: response ID absent — harness incorrectly reported cleanup success;
- contamination in a scratch file, persistent Git config, or remote URL was detected.

The current harness is not a reliable pass/fail gate for output or argv leakage and does not prove authenticated Git transport. Its cleanup hook is synthetic, not a Cloudflare revocation. It does not establish behavior for Cloudflare authentication, actual Artifact token denial after revocation, process inspection by other same-user processes, network logging, timeout-after-server-creation, or remote telemetry. No live Git mutation was made by this harness.

## Review and gate

- **OBSERVED:** independent review executed the baseline and seven in-memory mutations. Baseline exit was 0; four leakage/cleanup mutations also incorrectly exited 0. The test is rejected until output capture, token-only argv detection, response validation, and cleanup failure behavior are corrected and independently re-reviewed.
- **BLOCKED:** no new real Artifact credential may be issued while `CF-COLLAB-TOKEN-OUTPUT-001` has residual transcript exposure and an operator decision about that retained copy is outstanding.
- No real credential may be issued using this harness. Before any future use, implement or select a bounded broker with best-effort revoke in `finally`, short TTL, restricted scope, output redaction/suppression, and a safe failure path. Independently review it and require a fresh credential inventory and an old-token rejection check after revocation, after the residual transcript exposure receives an operator disposition.
