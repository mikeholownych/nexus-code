# Contest no-inventory credential lifecycle evidence — 2026-10-02

## Disposition

**BROKERAGE_DEMO_BOUNDARY_CORRECTION_REQUIRED**

One create and one authenticated Git read succeeded. The broker did not
capture an acknowledged revoke result, and no post-revocation read was made.
This lifecycle is not qualified for demo handoff.

## Scope and implementation

- Mode: `CREATE_ONCE_NO_INVENTORY`.
- Protected broker: `/opt/nexus-cloudflare-broker`.
- Installed manifest SHA-256:
  `534d43869cec4ddbfb2f3814609aeb96582e9259d68d836fe966692a0969da2c`.
- Installed probe SHA-256:
  `f4b8e8f6e22da0799fc661446986dd22f1dcae5187af7e7d0d9c84d14e60f10e`.
- Installed lifecycle reducer SHA-256:
  `8b930f20e7339df0e948f0b7a3631eca10f10895b9b6beffe663be0e8683bc8a`.
- Reviewed bundle index SHA-256:
  `1f6442e162dd85147aae517b049bca4b6cb0ecdb6653adcc1b3cd3de011c76cd`.
- Protected install verification passed: 2,550 objects and 7 system
  dependencies. Broker version and clean-start checks passed.
- The initial updater attempt failed closed while checking staged directory
  permissions, before modifying the installed tree. A corrected updater was
  independently reviewed and run only from its root-owned, hash-verified copy
  (script SHA-256
  `f19de807c726f9cde6055211e72054b4bb1ae87c45c66e0fcde8908efd2e6f02`).
- The old and new install trees were checked against their pinned manifests;
  the reviewed update was performed by an atomic directory exchange. The
  updater reported `cloudflare_operations=0`.
- Independent pre-install review approved the exact bundle and updater hashes
  for this bounded update. Independent post-update review verified the
  installed manifest and source hashes.

## Cloudflare and Git operations

The protected broker command was invoked once:

```text
sudo -n /opt/nexus-cloudflare-broker/bin/nexus-cf-broker credential-probe
```

The broker reported:

- Create attempts: `1`.
- Create result: `SUCCESS_WITH_ID`.
- Token ID: `woh2sni4v09aj9hw` (non-secret identifier).
- Scope: `read`.
- Expiry metadata: `2026-10-02T16:36:26.047Z`; requested-TTL metadata matched
  300 seconds. TTL enforcement is unproven.
- Token inventory/list calls: none.
- Pre-revocation `git ls-remote` succeeded and returned the expected baseline
  HEAD `ec3affd0e916b895e3528de6747b632f428359c0`.
- Revocation attempts: `1`, against the ID returned by create.
- Revocation acknowledgement: none captured. `permissionDenied` was false;
  the precise failure class was not retained.
- Post-revocation authentication rejection: not attempted.
- Revocation-to-rejection interval: unavailable.
- Broker result: `REVOCATION_AMBIGUOUS`; command exited nonzero.

No additional create, list, or revoke command was issued after this result.
Cloudflare CLI help subsequently confirmed that revoke-by-ID exists and warns
that a revoke shortly after creation can return an eventually-consistent 404.
The first result does not identify a 404, so the documented retry condition
was not established and no retry was made. The recorded expiry time has since
passed, but no revocation or TTL-enforcement guarantee is inferred from that.
Current active-token inventory is unknown.

## Secret and Git configuration checks

The broker's sanitized result reported:

- `plaintextReturnedToCaller=false`.
- `processArgsClean=true`.
- `remoteUrlClean=true`.
- `gitPersistentConfigClean=true`.
- `persistentFilesClean=true`; `scanErrorObserved=false`.
- `tokenInventoryUsed=false`.

The outer broker result and this evidence contain no credential plaintext.
The create response's stdout is captured internally and contains the
credential by design; the broker does not emit that field to its outer result.
The aggregate `credentialOutputClean=true` was emitted, but is not treated as
proof that the internal create-stdout channel was secret-free. The Git output
and revoke-output checks are broker-reported only. The post-revocation output
check was **not exercised** because no post-revocation request occurred.

The independent reviewer confirmed that the returned result and this evidence
contain no credential plaintext and independently verified installed source
hashes. The reviewer could not inspect the broker's transient raw capture, so
runtime output and scratch-scan flags remain broker-reported evidence, not
independently reproduced observations.

Separate local checks found no `http.extraHeader` in repository, global, or
system Git config; no repository remote was configured; and the broker probe
lock file was absent after exit. No credential-bearing remote or persistent
Git config remains from this operation.

## Independent review and unresolved items

Independent review disposition: **LIFECYCLE_NOT_QUALIFIED — REVOCATION
UNRESOLVED**.

The review independently established from the sanitized result and installed
state that there was one successful create, one successful authenticated
read, no inventory call, and one unacknowledged revoke attempt. It did not
establish revocation, token inactivity, or post-revocation rejection. The
broker's first-revoke failure class is unavailable; `permissionDenied=false`
does not prove the 404 condition required for the bounded retry.

No provider credential plaintext is included in this evidence. The known
credential's active state is **UNKNOWN**. Do not hand the broker to the demo
worktree until a separately authorized recovery path resolves this lifecycle
and a complete bounded lifecycle is qualified.

## Reproduction boundary

No demo worktree was run. No Worker or Artifact repository was created,
modified, or deleted. This execution made one token-create API request and
one exact-ID revoke API request; Git operations were read-only. No token
inventory call, second create, source publication, Git push, tag, or remote
creation occurred.
