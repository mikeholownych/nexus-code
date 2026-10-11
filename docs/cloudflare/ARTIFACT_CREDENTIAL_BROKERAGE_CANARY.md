# Artifact Credential Brokerage Canary

**Status:** The first synthetic harness is rejected. A replacement process-boundary harness passed its baseline and seventeen negative controls and received an independent synthetic-gate qualification. No real Artifact credential was created in this recovery.
**Date:** 2026-10-02

## Root cause in the rejected harness

The first `token-broker-canary.mjs` mostly passed canary strings to a detector function as in-memory values. It did not observe the actual final stdout/stderr boundary, actual child argv, a real child environment handoff, cleanup failure, or broker process death. Its cleanup hook treated assignment of an ID as successful revocation. Consequently, it reported success under fault injections that leaked or failed cleanup. Do not reuse it as a security gate.

## Replacement synthetic process-boundary test

The replacement [broker-gate-canary.mjs](../../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/broker-gate-canary.mjs) launches the separate [broker-gate-helper.mjs](../../experiments/cloudflare-artifacts-vertical-slice/agent-collab-worker/broker-gate-helper.mjs) with a random synthetic credential and captures helper stdout/stderr. The helper launches a child process that receives and verifies the synthetic value using a digest, without returning it. The test exercises a disposable Git repository, remote/config files, temporary files, and helper abnormal termination; the parent scans its captured output and scratch state and removes scratch resources.

Seventeen negative controls deliberately inject a canary into helper stdout, helper stderr, child argv, child token-only argv, helper argv, helper token-only argv, process-environment persistence, environment file, remote URL, local Git config, global Git config, temporary file, evidence file, secret-bearing filename, symlink target, a failed removal leaving secret-bearing residue, and SIGKILL residue.

**OBSERVED:** baseline exited successfully; all seventeen injected cases were detected; the actual synthetic child handoff succeeded; parent verified scratch cleanup. An independent reviewer reran the pair and found no false negative among these asserted controls. This qualifies the synthetic fault-detection gate only; it is not a production broker and not a Cloudflare test. It does not establish process visibility to other same-user processes, remote telemetry, Cloudflare output interception, or revocation semantics. No live Git mutation occurred.

## Independent review and issuance gate

- **OBSERVED:** independent review rejected the first harness after demonstrating false negatives.
- **QUALIFIED (bounded):** independent synthetic-gate review confirmed all seventeen controls exercise the stated subprocess/filesystem boundaries and are detected. A second prior review of the earlier 14-control version had found gaps; those were corrected before the latest qualification.
- **BLOCKED:** no real Artifact credential may be issued until a production broker is independently qualified. The synthetic gate's qualification does not approve invoking the current `cf` command through a broker.
- A future credential probe must capture CLI/API output inside a trusted local process, fail closed on malformed response or uncertain cleanup, use short TTL and minimal scope, avoid secret-bearing argv/remote/config/evidence, revoke in a `finally` path, and verify active-token inventory. This canary itself does not establish those real-provider behaviors.
