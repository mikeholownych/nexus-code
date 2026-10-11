# Brokerage installer retry and installed-boundary evidence

## Scope and provenance

- Starting and final repository HEAD: `fb8cc879f0faccfd92b9174a80c34246b72455a5`.
- No commit, push, tag, or remote change was made.
- The original reviewed installer failed once. Root cause: `INSTALLER_IMPLEMENTATION_DEFECT` at `npm ci`, exit 1. npm was configured with `/dev/null` as both user and global config and rejected the duplicate config path. The failure preceded the install-tree move; the target did not exist afterward.
- Historical bundle index: `3c4c0ec3f088c0cbdb55611c0700e9ec9512f26fb94967b30bf9148237ed9fbe`.
- Corrected bundle index: `5c7cd51c3cea95a3390a6727d1c300df3310d0d321cb7d7487f40355904f0faf`.
- Manifest SHA-256 remains `9833c1f471e62fe70301e20864dc373b35287f2d6194ec9a877f713d75732134`.
- Corrected review package SHA-256: `1279473d2f7d6b217cca368c343787938b3a8605a927fda1b1f592b1d9ec1e1c`.
- Separate reviewer disposition: `INSTALLER_DELTA_APPROVED`. It verified the exact final bundle, installer, and review package identities; failure/success/SIGTERM/cleanup fault fixtures; bounded diagnostic permissions; and the added failure map.

## Corrected retry and installed tree

The single corrected retry used the clean reviewed root invocation. It exited 0. The corrected installer uses distinct npm user/global configuration paths. On failure it records a stage and status in a root-only diagnostic directory, preserves at most 40 lines from npm output, reports actual workspace cleanup status, and removes temporary work. No Cloudflare credential operation occurred during installation.

Installed tree: `/opt/nexus-cloudflare-broker`, root-owned mode `0755`. Independent manifest verification passed with 2,550 objects and seven system dependencies. The unprivileged post-install qualification exited 0 and all nine checks passed:

- manifest/runtime identity;
- normal-user mutation denial;
- hostile startup injection did not execute;
- trusted `cf` version entrypoint ran;
- clean environment observed;
- protected saved-profile authentication succeeded;
- isolated Python import-shadow negative control passed;
- synthetic broker suites passed;
- synthetic suites used fake Cloudflare commands only.

Independent reviewer reran the installed gate as UID 1000, independently verified the object manifest and startup/auth/synthetic checks, and attempted mutation/rename/create probes. All passed; output was status-only, stderr empty, and the synthetic suite reported zero Cloudflare operations. Disposition: `INSTALLED_BOUNDARY_QUALIFIED` for Steps A–F only.

## Real credential lifecycle attempt

The protected `credential-probe` was invoked exactly once. It stopped before token issuance because its initial active-token inventory request failed. Sanitized probe result: `probeAttempted=false`, `issueStatus=not-started`, lifecycle `NO_CREDENTIAL`, `newlyObservedTokenCount=0`, `passed=false`. Therefore no Git authentication, revocation, or post-revocation authentication test occurred.

A separate read-only invocation of the same inventory operation through the protected Node and pinned `cf` entrypoint exited 1, with empty stdout and 73 bytes of stderr classified as a permission denial; it was captured in-process and only sanitized status/classification was emitted. No token-creation command was sent. The exact permitted operation needed to inventory repository tokens is not available to the authenticated profile in this execution path. Do not retry credential creation or claim the lifecycle qualified.

Disposition: installer and installed execution boundary qualified; real credential lifecycle blocked by token-inventory permission. `BROKERAGE_DEMO_BOUNDARY_QUALIFIED` is **not** established. TTL enforcement remains `TTL_ENFORCEMENT_UNPROVEN`. The accepted same-UID saved-profile limitation remains.

## Secret and resource state

No new credential was issued. No credential plaintext was emitted or persisted by the probe output. The broker's probe scratch directory and lock were cleaned by the probe. The protected install and staged bundle are retained for review; no public endpoint was created. Existing token inventory could not be read, so total active-token count remains unknown. No new security incident was observed.

The previous incident remains `CONTAINED_WITH_RESIDUAL_RETENTION_UNKNOWN`. E3 original remains `EXPERIMENT_3_CORRECTION_REQUIRED`; E3R remains `E3R_QUALIFIED_DIRECTIONAL_RESULT`; neither was rerun.
