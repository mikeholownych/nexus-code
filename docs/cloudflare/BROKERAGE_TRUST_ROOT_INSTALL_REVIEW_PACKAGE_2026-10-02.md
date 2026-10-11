# Protected Cloudflare broker install review package

**Historical independent disposition:** `BROKER_INSTALL_BUNDLE_APPROVED_FOR_OPERATOR_REVIEW` for the original bundle only; corrected delta is pending.
**Current state:** original installer failed before installation; a bounded correction is prepared and awaits independent delta review. No retry, Cloudflare operation or credential issuance has occurred.

## Superseding installer failure and correction

The originally approved bundle used index SHA-256
`3c4c0ec3f088c0cbdb55611c0700e9ec9512f26fb94967b30bf9148237ed9fbe`; its review package SHA-256 was
`1789484eedc6df20ed79983c27211df6a26410ba4b8c639e6228a556c8e86df5`.
The exact reviewed installer was run once and exited 1 during `npm ci`.
A root-private diagnostic reproduction established npm's error:
`double-loading config "/dev/null" as "global", previously loaded as "user"`.
The failure occurred before installation-tree move; the target remained absent,
and temporary-workspace cleanup succeeded. Node signature verification passed.
This is classified `INSTALLER_IMPLEMENTATION_DEFECT`.

The minimum correction gives npm a distinct, private empty global-config file
while retaining `/dev/null` as user config. The installer also records a
non-secret stage and exit status in a unique mode-0700 root-only diagnostic
directory on failure, retains at most 40 lines of the two npm command logs,
and records whether temporary-workspace removal succeeded or failed before reporting cleanup status. It uses no shell tracing or environment
dump. The corrected procedure changes no runtime, package version,
authentication behavior, or installed-tree manifest. Independent delta review
is pending; this package does not authorize retry until that review approves.

Corrected bundle index SHA-256:
`5c7cd51c3cea95a3390a6727d1c300df3310d0d321cb7d7487f40355904f0faf`.
Manifest SHA-256 remains
`9833c1f471e62fe70301e20864dc373b35287f2d6194ec9a877f713d75732134`.
The corrected review-package SHA-256 is reported after this file is finalized.

## Ordered installer failure map

The installer is `set -euo pipefail`; uncaught nonzero statuses terminate at the following ordered operations. Before the EXIT diagnostic trap exists, failures can only emit the explicit safe preflight message (or the failing utility's own diagnostic): (1) UID check; (2) `/opt` directory/symlink/owner/mode checks; (3) script realpath and staged-bundle directory/owner/mode/type checks; (4) per-object owner/mode checks; (5) target-absence check; (6) bundle and manifest SHA-256 checks; (7) workspace creation; (8) diagnostic-directory creation (its failure explicitly attempts workspace removal).

After the trap is installed, the stage field and possible failing operations are: (9) exact indexed-file closure (`awk`, `sort`, `find`, `cmp`); (10) Node signature/fingerprint (`gpgv`, `grep`); (11) archive download (`curl`); (12) archive checksum and expected digest (`sha256sum`, `awk`, shell comparison); (13) archive extraction and pinned Node version; (14) protected tree directories/files (`mkdir`, `install`); (15) distinct npm config creation and `npm ci`; (16) `npm audit signatures`; (17) credential-free `cf --version`; (18) isolated Python normalization; (19) staged manifest verification; (20) atomic move to install root; (21) final manifest verification. The normalize helper can fail on argument parsing, root check, filesystem traversal or chmod. The verifier can fail on argument/manifest parsing, digest reads, missing/type/owner/mode/content/symlink/extra-object/system-library checks. On any trapped failure, only the stage/status plus bounded tails from npm operations are retained in the private diagnostic directory; cleanup outcome is reported after the actual removal attempt. No `set -x` or environment dump is used.

The reproduced failure was stage 15 (`npm ci`), exit 1, due to identical npm user/global config paths. No operation reached the atomic move; target absence was independently checked afterward.

## Decision summary

Option A is staged as the candidate because the existing Cloudflare `cf`
profile avoids introducing a new API bearer credential source. It is larger
than Option B: a static launcher, Node runtime, pinned `cf` CLI, 34 resolved
packages, broker code and host libraries. Option B would use a smaller native
or Python REST helper, but no independently protected API-token source or
execution identity has been provisioned. It would add a second credential
delivery mechanism. Neither option is installed or qualified for real
credential operations.

The bundle protects the **code/runtime identity** against same-user
replacement after root installation. It does not isolate the saved OAuth
profile from other processes running as the same Unix UID. A same-UID process
can read that user-scoped profile and can invoke Cloudflare CLI operations
directly. Treat this as a material limit of Option A; this package does not
claim least-authority containment from a malicious same-UID process.

## Runtime and package identities

- Current caller-owned discovery runtime: Node `v24.11.1`.
- Current CLI: npm package `cf@1.0.0-beta.10`; the observed resolved
  entrypoint is `/home/mike/.local/node-v24.11.1-linux-x64/lib/node_modules/cf/bin/cf`.
- The current `cf` launcher has a `#!/usr/bin/env node` shebang; its file and
  package tree are user-owned/writable and are not trust inputs.
- Candidate protected runtime: official Node `v24.21.0`, Linux x86_64.
- Candidate protected CLI: `cf@1.0.0-beta.10`, pinned by `package.json` and
  lockfile v3. The lock has 65 package records, registry HTTPS tarball URLs
  and integrity entries; npm resolved 34 packages on this host.
- Node official archive SHA-256:
  `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`.
  Its hash is checked against the official signed `SHASUMS256.txt`; signature
  verification uses the pinned Node release keyring and the pinned signer
  fingerprint. `npm audit signatures` must pass at install time.
- The installed tree is host-specific. Its manifest pins 2,550 objects
  (directories/files/symlinks), seven Node shared-library dependencies and
  their parent directories, owner/mode expectations, paths and digests.

Cloudflare currently documents Node 22.18+ and says `cf auth login` stores a
CLI profile; `CLOUDFLARE_API_TOKEN` takes precedence over saved profiles.
Sources: [Cloudflare CLI install and authentication](https://developers.cloudflare.com/cf/get-started/),
[Cloudflare CLI environment variables](https://developers.cloudflare.com/cf/environment-variables/),
[Node release keys](https://github.com/nodejs/release-keys),
[Node v24.21.0 release artifacts](https://nodejs.org/dist/v24.21.0/), and
[npm registry metadata for cf@1.0.0-beta.10](https://registry.npmjs.org/cf/1.0.0-beta.10).

## Authentication compatibility

Metadata-only inspection observed:

- `/home/mike/.config/cloudflare/config/default.json`, mode `0600`, 11,728
  bytes;
- `/home/mike/.config/cloudflare/state.json`, mode `0600`, 153 bytes;
- `/home/mike/.config/cloudflare/cache/update-check-beta.json`, mode `0600`,
  99 bytes.

No contents were read, copied or included. The proposed launcher fixes
`HOME=/home/mike`, `XDG_CONFIG_HOME=/home/mike/.config`, cwd `/`, and unsets
all inherited variables, including `CLOUDFLARE_API_TOKEN`. That preserves the
documented default-profile selection path while preventing caller-selected
environment and cwd redirection. Cloudflare CLI documentation does not
document these concrete profile file paths; they are local metadata
observations. Authentication through the protected tree remains unverified
until the harmless post-install `cf auth whoami` gate.

## Trusted layout and manifest

Proposed install root: `/opt/nexus-cloudflare-broker/`.

- Root and all installed objects: `root:root`.
- Root directory and `/opt`: `0755`; inner directories `0555`.
- Launcher and Node executable: `0555`.
- Package, broker and manifest files: `0444`.
- Package symlinks retain their exact link targets; protected parent
  directories prevent replacement.
- Launcher: static ELF, fixed absolute Node and CLI/broker paths, fixed cwd,
  explicit environment, no shell, no PATH resolution for the trusted Node,
  and only four fixed operation names.
- Installed manifest SHA-256:
  `9833c1f471e62fe70301e20864dc373b35287f2d6194ec9a877f713d75732134`.
- Bundle index SHA-256:
  `5c7cd51c3cea95a3390a6727d1c300df3310d0d321cb7d7487f40355904f0faf`.
- Bundle payload contains 25 files. It does not contain the downloaded Node
  archive, CLI credentials, auth profile, token, or generated runtime state.

`launcher.c` was compiled twice in the current environment with the exact
command in `build-launcher.sh`; both binaries matched at SHA-256
`e2053c809ef84b187b8e61a57ea0afa04ee5e5376dca79e5882bb7797a4d0cac` and
`ldd` reported a static executable. The bundle hash binds the binary, source,
manifest, installer and tests together.

## Exact operator installation procedure

These commands have **not** been run. They require operator approval and
privilege. First inspect this entire document and the bundle. Use a fresh
staging path; stop if it already exists.

```sh
/usr/bin/env -i HOME=/home/mike PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /bin/bash --noprofile --norc -euo pipefail <<'INSTALL'
src=/home/mike/nexus-code/experiments/cloudflare-artifacts-vertical-slice/trusted-broker-bundle
stage=/opt/nexus-cloudflare-broker-bundle
expected=5c7cd51c3cea95a3390a6727d1c300df3310d0d321cb7d7487f40355904f0faf
sudo /usr/bin/test -d /opt
sudo /usr/bin/test ! -L /opt
opt_owner=$(sudo /usr/bin/stat -c %u /opt)
[[ "$opt_owner" == 0 ]]
opt_mode=$(sudo /usr/bin/stat -c %a /opt)
(( (8#$opt_mode & 022) == 0 ))
sudo /usr/bin/test ! -e "$stage"
sudo /usr/bin/test ! -L "$stage"
sudo /usr/bin/install -d -o root -g root -m 0700 "$stage"
sudo /usr/bin/cp -R --no-preserve=mode,ownership "$src/." "$stage/"
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C \
  /bin/bash --noprofile --norc -euo pipefail -s -- "$stage" "$expected" <<'VERIFY'
set -euo pipefail
stage=$1
expected=$2
umask 077
if /usr/bin/find "$stage" -mindepth 1 ! -type d ! -type f -print -quit | /usr/bin/grep -q .; then
  /usr/bin/echo "staging tree contains a symlink or special file" >&2
  exit 1
fi
/usr/bin/printf '%s  %s\n' "$expected" "$stage/BUNDLE.sha256" | /usr/bin/sha256sum --check --status -
(cd "$stage" && /usr/bin/sha256sum --check --status BUNDLE.sha256)
work=$(/usr/bin/mktemp -d /opt/.nexus-cloudflare-bundle-verify.XXXXXXXX)
trap '/usr/bin/rm -rf -- "$work"' EXIT HUP INT TERM
{ /usr/bin/awk '{print $2}' "$stage/BUNDLE.sha256"; /usr/bin/printf 'BUNDLE.sha256\n'; } | /usr/bin/sort >"$work/expected"
/usr/bin/find "$stage" -xdev -type f -printf '%P\n' | /usr/bin/sort >"$work/actual"
/usr/bin/cmp --silent "$work/expected" "$work/actual"
VERIFY
sudo /usr/bin/chown -R root:root "$stage"
sudo /usr/bin/find "$stage" -type f -exec /usr/bin/chmod 0444 {} +
sudo /usr/bin/chmod 0555 "$stage/bin/nexus-cf-broker"
sudo /usr/bin/find "$stage" -type d -exec /usr/bin/chmod 0555 {} +
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C \
  /bin/bash --noprofile --norc -euo pipefail -s -- "$stage" "$expected" <<'VERIFY'
set -euo pipefail
stage=$1
expected=$2
/usr/bin/printf '%s  %s\n' "$expected" "$stage/BUNDLE.sha256" | /usr/bin/sha256sum --check --status -
(cd "$stage" && /usr/bin/sha256sum --check --status BUNDLE.sha256)
VERIFY
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /bin/bash --noprofile --norc /opt/nexus-cloudflare-broker-bundle/install.sh
INSTALL
```

The complete block runs in a clean Bash with `-euo pipefail`, so a failed check stops subsequent commands. On failure, the corrected installer preserves safe stage/exit diagnostics and bounded npm log tails in a root-only directory under `/opt`; no environment dump or shell trace is produced. The copied tree remains root-owned and mode 0700 while a separate clean root Bash verifies the externally pinned index digest, all payload hashes and exact regular-file closure. Symlinks and special files are rejected before any chmod or public-readability change. Only then are modes normalized and the hashes checked again. Privileged Python helpers run with `-I -S`; the included negative-control test demonstrates that a caller-added module executes without isolation and is ignored with it. The installer repeats the type/file closure and payload checks. The installer separately checks every payload digest,
upstream Node signature/hash, npm lock/signatures, expected version and full
installed object manifest. It refuses if `/opt` is not a real root-owned
non-group/other-writable directory or if the destination already exists.
The installation is side-by-side and does not change the existing user Node,
`cf`, or authentication state.

## Post-install sequence and stop gates

Run after installation as the normal Nexus user, in order:

1. Run `python3.12 /opt/nexus-cloudflare-broker-bundle/post-install-qualify.py`.
   It verifies manifest/object identity, hashes, ownership, modes, parent
   directories and write-denial probes. It then tests hostile require/import
   preloads, `LD_PRELOAD`, PATH shadowing, hostile cwd and `.env`, user config,
   Node path and API-base overrides. Only boolean check results are printed.
2. The same script runs fixed `cf --version` and harmless `cf auth whoami`
   through the installed launcher; all identity output is captured and
   discarded. Any failure blocks credential issuance.
3. Only after the preceding checks pass, run the three bundled synthetic
   Node tests using `/opt/nexus-cloudflare-broker/runtime/node`. They use fake
   Cloudflare/Git commands only and must report zero Cloudflare operations.
4. Obtain a separate adversarial reviewer execution to rerun startup
   injection, immutable-path and synthetic tests. Only an independent
   qualification can permit a later real lifecycle probe.

Corrected bundle index SHA-256: `5c7cd51c3cea95a3390a6727d1c300df3310d0d321cb7d7487f40355904f0faf`. The historical pre-install checks passed on the original bundle; the correction has not yet been independently reviewed or retried. The final delta reviewer must assess the correction and rerun relevant non-Cloudflare checks. Original checks included: launcher injection 11/11; isolated Python import-shadow negative control passed; lifecycle 20 assertions; broker 18 cases plus four boundaries; descriptor-bound execution test passed. The independent reviewer reran these checks on the frozen digest, verified all 25 payload hashes and exact file closure, and approved the bundle for operator review. Protected-tree installation and authentication compatibility remain untested.

## Rollback procedure

After verifying the staged bundle index digest above, and only if the
installed manifest still matches exactly:

```sh
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /bin/bash --noprofile --norc \
  /opt/nexus-cloudflare-broker-bundle/rollback.sh
```

Rollback removes only `/opt/nexus-cloudflare-broker`. It verifies the exact
installed manifest and tree first and refuses removal on mismatch. It never
removes the caller-owned Node/`cf` installation or Cloudflare authentication.

## Review state

Earlier independent reviews found and falsified staging ownership, symlink ordering, unindexed-module, and fail-open paste-sequence assumptions. The final frozen digest resolves those findings and received independent approval for operator review only.
No local commit has been created. The original installer was run once and failed at the documented npm stage; no installation tree exists. No Cloudflare operation, credential issuance, E3/E3R rerun or vertical-slice work occurred. The independent delta reviewer must inspect the installer/README/procedure delta and determine whether the original bundle review remains valid. The corrected installer has not been run.
