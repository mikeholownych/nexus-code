# Final Real Credential Lifecycle Attempt — 2026-10-02

## Disposition

**BROKERAGE_DEMO_BOUNDARY_REAL_LIFECYCLE_AMBIGUOUS**

The protected broker invoked exactly one repo-scoped Artifact token CREATE
command. Its sanitized result reports `DEFINITE_PROVIDER_REJECTION` and
`permissionDenied=true`, but the evidence contains no HTTP status, provider
error code, or retained structured response that establishes the rejection
came from Cloudflare. The broker's permission classifier also matches broad
permission-related text on any nonzero CLI exit. A local CLI/configuration
failure therefore cannot be ruled out. No token ID or credential was returned
to the caller, but that does not prove Cloudflare created no token. Treat the
issuance state as ambiguous, with possible credential/orphan state unknown.

The lifecycle stopped before Git authentication or REVOKE. There was no CREATE
retry and no token inventory/list request. This is not a successful credential
lifecycle and does not qualify the demo boundary.

## Baseline and pre-execution checks

- Source HEAD before and after: `fb8cc879f0faccfd92b9174a80c34246b72455a5`
- Prequalification record SHA-256:
  `9873cedc893e7eda0345c54eade345e28a756991a78019a601ba75c4a6b2e7e3`
- Installed manifest SHA-256:
  `45fbd05f3ef0fbb54fa3b6e9feb426c98736be19e02dfa4df2553fd24ddb8879`
- Installed safe-probe SHA-256:
  `a54c8de93278d22266e89aeb14581d505668f3f9a9130ee73c4bcbc363ebd8ff`
- Installed response-classifier SHA-256:
  `32cfefbf3225de36a0de3f4348e52a0294726fdbe7744a957e253e2eeed755d1`
- Installed verifier passed: 2,551 objects and 7 system dependencies.
- The source checkout had no remotes. Local/global/system Git config had no
  `http.extraHeader`.
- Broker inspection confirmed one CREATE call site, no CREATE retry loop, no
  token list command, and a maximum of two revoke calls with the second after
  1,200 ms.
- Probe scratch and lock were absent before execution.
- Preflight timestamp: `2026-10-02T19:03:57.278619514Z`.

The read-only repository metadata check returned namespace
`nexus-exp1-oct02`, repository `external-git-proof`, ID
`4v94nnw1eqf0sanw`, default branch `main`, and the exact remote embedded in
the protected probe. The configured expected Git HEAD is
`ec3affd0e916b895e3528de6747b632f428359c0`.

## Lifecycle observations

| Stage | Observed result |
| --- | --- |
| CREATE attempts | 1 |
| Broker-reported CREATE classification | `DEFINITE_PROVIDER_REJECTION` |
| Broker-reported provider rejection | `true` |
| Broker-reported permission denied | `true` |
| Independently established Cloudflare response | No; status/code/structured provider response were not retained |
| Evidence disposition of issuance | Ambiguous; provider or local CLI origin unverified |
| Token ID / scope / expiry | Not returned; none recorded |
| Plaintext returned to caller | `false` |
| Inventory/list calls | 0 |
| Pre-revoke Git authentication | Not attempted; no credential was returned to the caller |
| Expected Git HEAD verified with new credential | No; Git was not attempted |
| REVOKE attempts / acknowledgement | 0 / not applicable |
| Post-revoke authentication test | Not attempted |
| CREATE retry | 0 |
| Same-ID revoke retry | 0 |

The protected command returned `passed=false` and stopped in
`NO_CREDENTIAL`. The broker intentionally discarded raw output; its
`DEFINITE_PROVIDER_REJECTION` label is broader than the surviving evidence
supports because a nonzero CLI exit with generic permission-denial text also
matches the classifier. The precise origin and permission are therefore
**unknown**. No permission change, inventory query, or second CREATE was
attempted.

## Timing

The probe result did not contain per-stage timestamps or durations. Therefore
the exact CREATE duration and lifecycle duration are **not available**. The
preflight time above is known; it is not used to infer the CREATE time. No
pre-revoke Git, REVOKE, retry, acknowledgement, or post-revoke rejection
interval occurred to time.

## Post-execution security checks

- Probe scratch directories: 0; probe lock: absent.
- Local/global/system `http.extraHeader`: absent.
- Git remotes: none; credential-bearing remote URLs: 0.
- Targeted temp scan for artifact-probe files: 0.
- Broker result: `credentialOutputClean=true`,
  `processArgsClean=true`, `plaintextReturnedToCaller=false`.
- Token-dependent broker fields such as `persistentFilesClean` were not
  reported as positive checks; the separate filesystem/config checks above are
  the observed residue checks. Provider-side token state remains unknown.
- Source HEAD remained unchanged. No commit, tag, push, or remote change
  occurred.

Operations in this attempt: one read-only repository metadata GET; one token
CREATE command invocation whose provider-side submission/result is unresolved;
zero inventory/list requests; zero REVOKE requests; and zero other mutation
commands. The `cf` command discovery and help queries were local CLI
operations. A successful credential mutation is not established; possible
provider-side token state remains unknown. The CLI invocation included
`--ttl 300`; provider acceptance and TTL enforcement remain unknown.

## Evidence classification and limits

**OBSERVED:** the protected broker reported one CREATE command attempt,
`DEFINITE_PROVIDER_REJECTION`, `providerRejected=true`,
`permissionDenied=true`, no token ID returned, no Git calls, no revoke, no
list, and no plaintext returned. The sanitized output contained no HTTP status
or provider error code. Post-run local scratch/config/remote checks passed.

**DERIVED:** this execution did not reach the credential-use/revocation part of
the lifecycle. Its acceptance criteria cannot pass. Because the CLI command
was invoked but its provider-side outcome cannot be established, the safe
disposition is ambiguous issuance rather than a confirmed external denial.

**UNKNOWN:** whether a provider request was accepted; whether a token exists;
exact provider status/error code; whether the permission text came from
Cloudflare or local CLI; precise missing permission; any stage timing not
emitted by the broker.

This attempt does not authorize a retry, inventory query, or another CREATE.
Any unresolved credential state requires operator remediation under the
existing bounded incident process; TTL expiry is not proof of cleanup.
