# Cloudflare Artifact Token CREATE Failure Delta — 2026-10-02

## Scope and baseline

This is a read-only comparison of the last retained successful token CREATE and the later invocation classified as a provider rejection. No CREATE, REVOKE, or token inventory operation was performed for this investigation. No broker or source code was changed.

- Source HEAD: `fb8cc879f0faccfd92b9174a80c34246b72455a5`.
- Failed lifecycle evidence SHA-256: `d88014b6e998d6a35519ce2eb3303ffdb0622218345bb210e7bf0991d5d942df` (verified).
- Earlier successful-CREATE lifecycle evidence SHA-256: `212bd3d99c7fb46f4e7c07d7102edb25b4f6cb66ff9dd3e2da8efc4e48946a75` (verified).
- Prequalification evidence SHA-256: `9873cedc893e7eda0345c54eade345e28a756991a78019a601ba75c4a6b2e7e3` (verified).
- Installed broker manifest SHA-256: `45fbd05f3ef0fbb54fa3b6e9feb426c98736be19e02dfa4df2553fd24ddb8879` (verified with the installed integrity verifier).

## Conditions comparison

| Property | Last successful CREATE | Failed CREATE | Assessment |
|---|---|---|---|
| Protected launcher | `/opt/nexus-cloudflare-broker/bin/nexus-cf-broker`; launcher digest `e2053c…d0cac` | Same path and digest | SAME |
| Broker installed manifest | Prior manifest `534d4386…9da2c`; old probe digest `f4b8e8…0f10e` | Manifest `45fbd05f…b8879`; current probe digest `a54c8de9…d8ff` | CHANGED |
| cf CLI | `1.0.0-beta.10`, same entry digest `5d3d8e…7c67` | Same version and digest | SAME |
| Node runtime | `v24.21.0`, same digest `7fde7b…6df4c` | Same version and digest | SAME |
| Invocation identity | `sudo -n … credential-probe`; effective UID/GID not separately captured (sudo invocation normally runs as root) | Direct launcher invocation; effective UID 1000 | CHANGED |
| HOME / XDG / cwd | Launcher fixes HOME `/home/mike`, XDG `/home/mike/.config`, cwd `/` | Same launcher controls | SAME (launcher-defined); historical effective environment was not fully captured |
| Account/auth profile | Prior account and auth source not recorded in sufficient detail | Current protected `auth-check` succeeded; identity matches the account encoded in the expected Artifact remote; default profile is under `/home/mike/.config/cloudflare` | UNKNOWN historically; current identity observed |
| Effective token-create permission | A prior read-scoped token was created successfully | Not established; current auth and repository metadata reads work, but do not prove token-create permission | UNKNOWN |
| Namespace/repository | `nexus-exp1-oct02` / `external-git-proof` | Same; read-only metadata returned repository ID `4v94nnw1eqf0sanw`, default branch `main` | SAME for target; current existence/read access observed |
| Request scope and TTL | `read`, requested TTL 300 seconds | `read`, requested TTL 300 seconds | SAME |
| CREATE command shape | One protected broker `credential-probe` invocation | One protected broker `credential-probe` invocation | SAME at exposed interface; no CREATE retry |
| Auth config metadata | Prior file state not retained | Current default config is UID/GID 1000, mode 0600, mtime `2026-10-02 18:48:21Z`; auth check works | UNKNOWN historical delta; current state observed |

The broker probe implementation changed between runs. The CREATE arguments and command path are unchanged. Its broad permission-text classification was already present in the earlier probe; the newer implementation also changed invocation-error handling and added revoke/post-revoke logic. The failed evidence does not retain sufficient process/provider response data to attribute the failure to these changes.

## Failed outcome and origin

The failed run recorded one CREATE invocation, no returned token ID or credential, no Git proof, and no revoke. Its first classification (`DEFINITE_PROVIDER_REJECTION`, `permissionDenied=true`) is not supported by retained provider-origin evidence. Independent review found that broad permission-related text can also come from local CLI failures. The authoritative interpretation is therefore:

`CREATE_INVOCATION_FAILED / PROVIDER_DISPOSITION_UNKNOWN`.

The failure origin is `FAILURE_ORIGIN_UNKNOWN`. The retained result does not establish a local pre-request failure, request submission, or an HTTP/provider response. It also does not establish that Cloudflare created no token.

## Classifier review

The installed probe sets `permissionDenied` using a broad regex over CLI stdout/stderr (including terms such as 401/403, permission denied, unauthorized, forbidden, and authentication error). For a nonzero child exit, a match sets `DEFINITE_PROVIDER_REJECTION`; parsed JSON stdout with `success: false` also sets that outcome. This does not distinguish local CLI/configuration failure from transport failure or a provider response. The raw output is discarded, and no structured HTTP status, provider error code, request-submission marker, or safe response envelope is retained.

For a future invocation, provider rejection should be called confirmed only when the CLI/API exposes structured, sanitized provider-origin evidence, such as HTTP status plus provider error code/envelope. Retain child exit class, whether request submission is known, HTTP status when available, provider code/type, and a bounded sanitized diagnostic classification. Otherwise classify origin as unknown. Do not retain raw output if it can contain credentials.

## Current read-only observations

- Protected `auth-check` succeeded and matched the expected account identity.
- Protected `version-check` reports cf `1.0.0-beta.10`.
- Read-only repository metadata access succeeded for the expected namespace/repository.
- Current config metadata and installed integrity checks passed.
- No token inventory/create/revoke operation was used.
- No Git remote or `http.extraHeader` configuration was introduced or changed.
- No source files were modified. Existing unrelated working-tree changes remain outside this investigation.

These current reads establish present authentication and repository-read access only; they do not establish Artifact token-create permission or the cause of the earlier failure.

## Contest assessment and recommendation

- Dynamic token creation is demo-blocking only if the planned demonstration depends on issuing a fresh repository-scoped credential at runtime. The lifecycle is presently unqualified and must be disclosed as such.
- A narrow provider-boundary observability correction is justified: preserve enough sanitized structured evidence to distinguish a provider response from local/transport failure. This is not evidence that the underlying credential approach caused the regression.
- General crash recovery, global token inventory, and production credential lifecycle design are post-contest engineering unless the demo demonstrates a concrete need.

Recommendation: `ONE_NARROW_OBSERVABILITY_FIX_JUSTIFIED`.

Next action (not performed): review the `cf` CLI's supported structured/debug response surface locally, then make one bounded classifier/evidence correction only if it can preserve provider origin without exposing credentials. No new real CREATE should occur without separate authorization. If the CLI cannot safely expose provider-origin evidence, reconsider direct ephemeral brokerage for the contest instead of adding broader lifecycle machinery.

## Epistemic limits

- **OBSERVED:** current protected auth check, current CLI version, current read-only repository metadata, current installed hashes, and retained historical evidence contents/hashes.
- **DERIVED:** previous and failed request target/scope/TTL match based on retained records; effective identity changed from sudo invocation to direct user invocation.
- **INFERRED:** UID/profile-context change could affect local CLI behavior, but current auth/read success does not prove it caused this failure.
- **UNKNOWN:** failed request submission/provider response; current and historical token-create permission; historical auth profile/account selection details; exact failed CLI output; whether a provider-side token was created; causal effect of the broker probe change.
