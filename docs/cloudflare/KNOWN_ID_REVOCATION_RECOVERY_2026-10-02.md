# Known-ID Artifact Token Revocation Recovery — 2026-10-02

## Scope and baseline

This investigation attempted recovery for only the already-known Artifact token ID `woh2sni4v09aj9hw`. It made no token create or list/inventory calls. It did not run the demo, modify the Cloudflare repository or Worker, alter Git remotes, or commit changes.

- Repository: `/home/mike/nexus-code`
- Required HEAD before and after: `fb8cc879f0faccfd92b9174a80c34246b72455a5`
- Prior lifecycle evidence SHA-256: `212bd3d99c7fb46f4e7c07d7102edb25b4f6cb66ff9dd3e2da8efc4e48946a75`
- Prior evidence file was left unchanged.
- Broker manifest SHA-256: `534d43869cec4ddbfb2f3814609aeb96582e9259d68d836fe966692a0969da2c`
- Installed broker manifest check: 2,550 objects checked, 0 missing or mismatched; 7 system runtime dependencies listed.

## Known-ID recovery attempt

The helper was independently reviewed, staged root-owned with mode `0700` for the directory and `0444` for its three files, and hash-verified before execution. It used the installed pinned Node runtime and bound Cloudflare CLI execution path.

- Operation: one direct revoke attempt for the exact known ID in namespace `nexus-exp1-oct02`.
- Attempt time: `2026-10-02T17:28:22.453Z`.
- Create calls: `0`.
- List/inventory calls: `0`.
- Revoke calls: `1`.
- Process exit: `1`; signal: none; child execution error: none.
- Sanitized classification: `PROVIDER_REPORTED_NOT_FOUND`.
- HTTP status: unavailable.
- Structured provider success envelope: unavailable.
- Provider error codes: none captured.
- Captured diagnostic lengths: stdout `0` bytes; stderr `177` bytes. Raw diagnostic text was intentionally not emitted or retained.
- Exact-ID revoke acknowledgement: **not received**.
- CLI surfaced a not-found diagnostic during this recovery attempt. Because no HTTP status or structured provider envelope was captured, this is recorded as a CLI-reported not-found result; it does not establish the precise provider-layer response.
- The transient staged files were removed after execution.

This result indicates that the CLI reported the object as not found at the time of this recovery attempt. It does not prove that the earlier revoke succeeded, establish when the object became absent, or prove that the original credential can no longer authenticate.

## Historical ambiguity investigation

### Observed

- The original lifecycle evidence records one successful create with a stable ID, one successful Git `ls-remote` using the read credential, one revoke attempt, and final disposition `REVOCATION_AMBIGUOUS`.
- It records no post-revocation Git authentication test and no create retry or token inventory call.
- The original revoke response's status, response envelope, diagnostics, and transport classification were not retained.
- The installed revoke path invokes revoke for the exact ID, parses a success envelope, checks diagnostics for permission-denied and not-found patterns, clears raw stdout/stderr, and returns only acknowledgement/attempt/permission/output-clean fields. An invocation exception similarly returns a generic non-acknowledged result.
- Consequently, `permissionDenied=false` means only that the code did not recognize its permission-denial patterns. It does not prove success, not-found, or transport health.

### Derived

- The original `REVOCATION_AMBIGUOUS` result is explained by information loss in the revoke result interface: the caller received no response class distinguishing provider denial, not-found, CLI failure, or transport failure.
- The recovery helper corrected its own response classifier after independent review found mixed-status edge cases. Its final synthetic suite has 11 cases, including 403 plus not-found text, HTTP 500 plus not-found text, and a nonzero process exit with a success envelope. All 11 pass.
- These synthetic cases validate classification behavior. They do not recover or establish the original provider response.

### Inferred

- The one-shot recovery's not-found text may reflect an underlying Cloudflare response, but the captured metadata is insufficient to attribute the diagnostic conclusively to the provider rather than CLI formatting.

### Unknown

- The exact provider/CLI response to the original revoke attempt.
- Whether the original revoke succeeded at that time.
- Whether the token became absent because of revocation, expiration, or another provider-side condition.
- Whether the historical credential would be rejected by Git now. Its plaintext was not retained and was not reconstructed; authentication was not tested.

## Provider contract reference

Cloudflare documents direct revoke by namespace and token ID as `DELETE /artifacts/namespaces/:namespace/tokens/:id`. A successful response uses the standard envelope with `success: true` and the revoked ID in `result.id`. This establishes the documented direct-revoke shape, not what happened in either historical request. See [Cloudflare Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/).

## Correction and qualification

No additional broker code change was made during this recovery. The bounded recovery classifier/test source in `experiments/cloudflare-artifacts-vertical-slice/revoke-known-id-recovery/` was corrected to avoid false not-found, permission-denied, and ID-mismatch classifications. The added assertions retain the intended expectation: an exact token must be shown unable to authenticate after revocation before a full lifecycle qualifies.

Independent review approved one exact-ID revoke execution only, after verifying the helper hashes and the 11-case synthetic suite. No credential was created, listed, or retried. No lifecycle qualification is claimed.

## Security and repository state

- No credential plaintext was emitted or retained by this recovery attempt.
- No new credential plaintext was searched for, reconstructed, or recovered.
- No token inventory was queried.
- The recovery helper's structured output contained no raw provider diagnostic.
- Temporary staged helper files were removed.
- No Git remotes were configured; no remote was changed.
- No commit, push, tag, demo execution, repository mutation, or Worker mutation occurred.
- The worktree contained unrelated pre-existing changes and untracked files; they were left untouched.

## Decision

**`NOT_READY_FOR_REAL_LIFECYCLE`**

The recovery did not produce a revoke acknowledgement, and the original credential cannot be tested after revocation without recovering its plaintext, which is prohibited. The accepted expectation remains unchanged. A future lifecycle requires separate authorization and must demonstrate post-revocation rejection of the same credential.
