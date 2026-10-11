# Contest Credential Lifecycle Prequalification — 2026-10-02

## Disposition

**READY_FOR_ONE_FINAL_REAL_LIFECYCLE** — this is synthetic implementation and
protected-install qualification only. It does not qualify the demo boundary.
No Artifact token was created, revoked, listed, or used for Git in this work.
The contest demo was not run. Cloudflare mutations: **zero**.

The previous real lifecycle remains `BROKERAGE_DEMO_BOUNDARY_CORRECTION_REQUIRED`:
it received one create acknowledgement and authenticated Git read, but its
revoke result was ambiguous and no same-credential post-revoke rejection was
observed. Historical credential inactivity remains unknown. This record does
not revise that result.

## Correction

The prior revoke handling retained acknowledgement and permission-denied
booleans, then cleared raw CLI output. A `permissionDenied=false` result could
not distinguish not-found, provider failure, transport failure, or another
ambiguous response. The previous real response was not retained and cannot be
reconstructed.

`broker/artifact-token-response.mjs` now retains only sanitized structured
classification evidence: process exit/signal/error code, HTTP status, presence
and success value of a provider envelope, response-ID match, numeric provider
error codes, and output byte counts. Provider messages and raw output are not
returned or persisted.

The revoke state machine permits at most one retry of the **same token ID**
after 1,200 ms, and only for an explicit HTTP 404 with either no structured
failure envelope or a nonempty envelope whose errors are all code `10200`.
Permission evidence, conflicting errors, other provider failures, transport
failures, status-less not-found text, and ambiguous output fail closed. The
create operation is never retried. Revoke acknowledgement requires a zero
process exit plus a successful envelope containing the exact requested ID.

The installed `cf` CLI help says token IDs are resolved through an eventually
consistent index, and a revoke within about one second of creation can return
404; it recommends retrying after a short delay. The CLI schema identifies the
operation as `DELETE /accounts/{account_id}/artifacts/namespaces/{namespace}/tokens/{id}`.
Cloudflare's [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
documents the standard error envelope and a generic code `10200` not-found
example; the [Artifacts error reference](https://developers.cloudflare.com/artifacts/api/errors/)
describes `10200` as `NOT_FOUND` for a repository or remote resource. Because
the public `10200` example is generic, the implementation requires the CLI's
explicit HTTP 404 as well and allows only one retry. This is documented CLI
behavior plus the documented envelope shape; it is **not** an observed token
revocation response.

After an exact revoke acknowledgement, the same in-memory credential is used
for a bounded harmless Git read. Only an authentication/authorization denial
qualifies. A successful read returning the expected HEAD means the credential
is still accepted; DNS/network errors, repository/path 404, process errors,
and mixed diagnostics do not prove rejection.

## Expectation governance

No existing test expectation was weakened or changed to match an accidental
implementation result. The required lifecycle expectation remains: the same
credential must authenticate before revocation and be rejected for
authentication afterward.

Two classifier cases were added. The HTTP 404 plus only code `10200` case is
provider-contract handling based on the CLI's documented eventual-consistency
404 and Cloudflare's standard error envelope. The code `10200` case without
explicit HTTP 404 is implementation-defect coverage: it ensures the retry
predicate remains stricter than a not-found code alone. The existing
conflicting `10400` provider error plus HTTP 404 text remains non-retryable.
The requirement is unchanged.

## Synthetic qualification

All test operations used fake Cloudflare/Git child programs and synthetic
credentials. The credential probe reported `cloudflareOperations=0`,
`allCasesCorrect=true`, and `noCanaryInOutputArgvOrDisk=true`.

| Suite | Result |
| --- | --- |
| Revoke/Git response classifiers | 14 revoke cases and 8 post-revoke Git cases passed |
| Credential lifecycle reducer | 25 assertions passed |
| Safe credential probe | 27 cases passed; includes ambiguous create, permission denial, provider/transport failure, exact-ID acknowledgement, same-ID bounded retry/exhaustion, same credential accepted/rejected, unrelated Git errors, and secret-surface checks |
| Linux bound execution | Passed; no real Git modification and zero Cloudflare operations |
| Installer Python boundary | Passed |
| Launcher | Passed |
| Shell syntax | `install.sh` and `rollback.sh` passed `bash -n` |

The probe cases also fault-inject output, argv, disk/config/remote, and cleanup
failures. The normal lifecycle succeeds only when it observes pre-revoke Git
success, exact revoke acknowledgement, and post-revoke authentication rejection.

## Protected installation

The reviewed bundle is installed at `/opt/nexus-cloudflare-broker`.

- Trusted manifest SHA-256: `45fbd05f3ef0fbb54fa3b6e9feb426c98736be19e02dfa4df2553fd24ddb8879`
- Bundle index SHA-256: `24770205917183ba5289efb69e83846250d7ee490f6f474d6feaa1e87bd6d141`
- Installed tree: 2,551 objects; 7 system runtime dependencies
- Read-only installed-tree verification: passed
- Normal-user post-install qualification: all checks passed, including exact manifest/runtime identity, normal-user mutation denial, hostile-startup rejection, protected `cf` version/auth check, Python import-shadow negative control, and all four synthetic suites
- Independent package review: approved manifest finalization and install
- Independent installed-tree review: verified installed manifest and object hashes; accepted `READY_FOR_ONE_FINAL_REAL_LIFECYCLE` based on the recorded normal-user qualification output

The old installed tree is retained under `/opt/nexus-cloudflare-broker-previous-20261002` and `/opt/nexus-cloudflare-broker-preupgrade-hold` for recovery. A stale prior rollback helper rejected its old tree before mutation because its pinned manifest did not match the installed tree; no deletion occurred. The new installed rollback helper is pinned to the new manifest.

No package dependency changed. Manifest preparation reran npm registry signature verification successfully; no vulnerability scan was required for a dependency change because there was none.

## Security and scope checks

- Targeted scans found no Artifact plaintext-token format, literal bearer credential, or quoted Cloudflare API-token assignment in the reviewed bundle.
- The synthetic canary did not appear in test output, argv, or disk assertions.
- Local, global, and system Git config contain no `http.extraHeader`; remote URLs contain no embedded credentials. The source checkout has no Git remotes.
- No source, evidence, shell history, Git config, or environment value was populated with a real Artifact credential by this work.
- The only Cloudflare operation was the existing protected read-only `cf auth whoami` post-install check. No token create, revoke, list/inventory, Git authentication, or demo operation occurred.
- No dependencies, remote configuration, commits, tags, or publication state changed.

The final operator-authorized real lifecycle is still required to establish
provider behavior end to end. It must create exactly one credential, prove
pre-revoke Git authentication, revoke the exact returned ID, and prove that
same credential is rejected afterward. Any ambiguous create/revoke result
remains fail-closed; this prequalification does not turn ambiguity into
success.
