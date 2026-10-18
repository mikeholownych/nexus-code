# Trusted Cloudflare contest transport install bundle

This bundle contains the protected broker source and installation recipe. An
earlier revision is installed at `/opt/nexus-cloudflare-broker`; this revision
adds fixed, bounded Artifacts Git and Worker operations for the contest demo.
It contains no Cloudflare credential or user authentication state. The
installer accepts only the recorded prior manifest, retains that installation
under a fixed hold path, then atomically installs and verifies the new tree.

## Candidate runtime and upstream authority

Observed caller-owned discovery installation: Node `v24.11.1`; npm package
`cf@1.0.0-beta.10`, entrypoint
`/home/mike/.local/node-v24.11.1-linux-x64/lib/node_modules/cf/bin/cf`;
the entrypoint is a `#!/usr/bin/env node` script and its complete package tree
is user-writable. Those files were not used as trust authority. Current
Cloudflare CLI documentation requires Node 22.18 or later and says the CLI
uses its own saved profiles; see the source links below.

The candidate protected runtime is Node `v24.21.0`, Linux x86_64. Its official
`node-v24.21.0-linux-x64.tar.xz` archive is pinned to SHA-256
`fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`. The
checksum is from the official signed `SHASUMS256.txt`; `SHASUMS256.txt.sig`
was verified with `gpgv` and the included Node release keyring. The keyring
was obtained from `nodejs/release-keys` at commit
`481637f813e912c4aa3622d7964ab426c97b8e8d`; keyring SHA-256 is
`610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00`. The
accepted release-signing fingerprint is
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.

The `cf` package is pinned to `1.0.0-beta.10`; npm registry metadata provides
tarball SRI `sha512-pv3zg8Y0sjgNuyKpDNsEBszTvSgRDzHccvHybJ6u4BjvesMZpS2T2twnOGvDo0PSnie/bCbA+hgzKWaDuIKtBw==`.
`package-lock.json` pins all 65 lock entries, including resolved registry URLs
and integrity values. The pinned Node distribution's npm runs `npm ci --ignore-scripts`; `npm audit signatures` is required to succeed. The installed platform-specific closure is recorded in the regenerated manifest. No development dependencies are
installed. The package startup check runs `cf --version` under the pinned Node
runtime without credentials.

The seven direct production dependencies in the observed `cf` package
metadata are `@cloudflare/build-output-utils@0.8.4`,
`@cloudflare/codemods@0.3.0`, `@cloudflare/config@0.22.0`,
`@cloudflare/runtime-types@0.1.6`, `blake3-wasm@2.1.5`,
`miniflare@5.20260930.0-alpha`, and `minisearch@7.2.0`. The lock, rather than
this summary, is authoritative for the full transitive and optional closure.

The lock and package metadata are derived from the npm registry and recorded
as reviewable artifacts; the candidate package tree is not trusted merely
because the current local copy has matching files. Registry SRI and npm's
registry signature/provenance audit are the authority for package bytes.
The installer keeps user and global npm configuration paths separate: the
user config is `/dev/null`, while the global config is a private empty file in
the temporary install directory. npm rejects using the same path for both
configuration scopes.

## Proposed filesystem and trust graph

```text
/ (root:root 0755)
└── opt (root:root 0755)
    └── nexus-cloudflare-broker (root:root 0755)
        ├── bin/nexus-cf-broker (static ELF, root:root 0555)
        ├── runtime/node (Node v24.21.0, root:root 0555)
        ├── cf-runtime/ (root:root; directories 0555, files 0444)
        │   ├── package.json
        │   ├── package-lock.json
        │   └── node_modules/cf and the lock-pinned production closure
        ├── broker/ (root:root; files 0444)
        └── share/trusted-object-manifest.json (root:root 0444)
```

The static launcher clears the inherited environment before Node starts,
changes cwd to `/`, sets only fixed `HOME=/home/mike`,
`XDG_CONFIG_HOME=/home/mike/.config`, `PATH=/usr/bin:/bin`, locale and
non-secret display settings, then `execve`s the absolute Node executable and
one fixed CLI/broker entrypoint. It accepts the existing qualification
operations plus `demo-transport`; callers cannot provide an executable,
module, arbitrary Git arguments, URL, credential path, or working directory.
The demo operation is accepted only when the root-owned launcher runs with
real/effective UID 0 and receives `SUDO_UID=1000`, which sudo sets from the
authenticated invoking identity after filtering caller environment. Direct
unprivileged invocation is rejected. The intended invocation is
`sudo -n /opt/nexus-cloudflare-broker/bin/nexus-cf-broker demo-transport`.
This admits the configured Nexus user because the host sudo policy authorizes
that user; it does not distinguish separate same-UID processes. A bounded
`capability-status` operation reports only `CUSTODY_VALID`, `NOT_PROVISIONED`,
or `CUSTODY_INVALID` for the two fixed capabilities. `CUSTODY_VALID` verifies
fixed-path file custody metadata, not provider authentication. It returns no path, file
metadata, digest, or capability contents. The broker binds its Git executable
before use. The launcher contains no Cloudflare business logic.

Node is a dynamically linked official binary. The manifest therefore pins the
observed system ELF dependencies and their resolved paths, ownership, modes,
and digests, plus their parent directories. The regenerated manifest has 2,570
installation objects: 236 directories, 2,329 regular files, and 5 symlinks,
plus 7 system runtime libraries. This is host-specific to Linux x86_64,
glibc, UID/GID 1000 and the observed system libraries. Any mismatch fails
installation/qualification; it is not silently adapted.

## Authentication separation and remaining boundary

The existing Cloudflare API profile is used only by the separately qualified
read-only `auth-check`; it is not used for Artifacts Git or Worker operations.
Those operations read separate fixed capability files from
`/etc/nexus-cloudflare-broker/`: `artifacts-git.token` and `worker.bearer`.
The directory is root-owned mode 0700; each file, when provisioned, must be a
root-owned regular file mode 0400 with one link. The caller cannot select
either path. Capabilities are provisioned separately and remain outside the install tree. The
Git token is supplied only as a transient Git HTTP header in the protected
child environment, and the Worker bearer only as an in-memory HTTP header.
Neither appears in the controller result, remote URL, persistent Git config,
or evidence.

This is a controlled demo boundary, not protection from root, host compromise,
or a malicious process with equivalent unrestricted sudo authority. On this
host, the `mike` account has `NOPASSWD: ALL`; an independently malicious local
process can therefore act as root outside this broker. The truthful demo claim
is that the controller/agents are not handed these credentials through this
operation protocol or its results, not that the host user is technically
unable to obtain them.

Clean-start authentication has **not** been exercised through the proposed
protected installation. `auth-check` is a required post-install harmless
gate. User auth state remains same-UID user state: a same-UID process that can
read `/home/mike/.config/cloudflare` can use the saved `cf` profile directly.
This bundle protects the broker code/runtime from substitution; it does not
create Unix identity separation or make the OAuth profile inaccessible to
other same-UID processes. The operator must account for that authority fact
when deciding whether the installation can serve as a least-authority broker.

## Exact pre-install procedure (operator only)

The checks below are instructions, not executed actions. Use the external
`BUNDLE.sha256` digest reported with this reviewed bundle; do not trust a
digest copied from an unverified staging directory.

```sh
export EXPECTED_BUNDLE_INDEX_SHA256='<digest printed by independent bundle review>'
: "${EXPECTED_BUNDLE_INDEX_SHA256:?set the independently reviewed BUNDLE.sha256 digest}"
/usr/bin/env -i HOME=/home/mike PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /bin/bash --noprofile --norc -euo pipefail -s -- "$EXPECTED_BUNDLE_INDEX_SHA256" <<'INSTALL'
src=/home/mike/nexus-code/experiments/cloudflare-artifacts-vertical-slice/trusted-broker-bundle
stage=/opt/nexus-cloudflare-broker-bundle-v4
expected=$1
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
{ /usr/bin/awk '{path=$2; sub(/^\.\//, "", path); print path}' "$stage/BUNDLE.sha256"; /usr/bin/printf 'BUNDLE.sha256\n'; } | /usr/bin/sort >"$work/expected"
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
  /bin/bash --noprofile --norc "$stage/install.sh"
INSTALL
```

The complete block runs in a clean Bash with `-euo pipefail`, so any failed check stops the sequence. Staging remains root-owned and mode 0700 while the externally pinned index, all payload hashes and the exact regular-file set are verified. Symlinks and special files are rejected before chmod. Replace the digest placeholder with the exact independently reviewed index digest printed in the terminal report. Verify `/opt` is a real root-owned,
non-group/other-writable directory before approval. The installer verifies
the existing protected tree against the recorded prior manifest before it
stages an update. It downloads only the pinned Node archive, verifies its
signature/hash, installs the unchanged npm lock closure with lifecycle scripts
disabled, verifies npm registry signatures, normalizes ownership/modes, and
checks the new object manifest before and after the atomic move. It retains the
prior install at `/opt/nexus-cloudflare-broker-previous-7f9de0af9cef`. It
validates only fixed capability path custody metadata and preserves the
capability files without reading, hashing, copying, or altering their contents.

## Post-install gates (normal Nexus user)

Run in this order, only after installation:

1. Verify the manifest, all trusted objects, system libraries and protected
   parent directories; attempt write/replace probes as UID 1000.
2. Run `python3.12 /opt/nexus-cloudflare-broker-bundle-v4/post-install-qualify.py`.
   It passes hostile `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_PRELOAD`, cwd,
   npm and API-base variables to the fixed launcher. A protected check script
   verifies the actual Node process sees the allowlisted environment and cwd;
   it requires no preload/PATH marker, requires the pinned `cf` version, and
   silently checks
   `cf auth whoami` under the clean saved-profile environment. Output retains
   only booleans and exit status, not Cloudflare identity output.
3. Only if 1–2 pass, run the synthetic test files bundled under `broker/` as
   the normal Nexus user. The demo transport fixture uses only local bare Git
   repositories, synthetic canaries, and a local Worker response seam.
4. Confirm the direct normal-user `demo-transport` invocation is rejected even
   with a forged `SUDO_UID`, then use the protected `capability-status`
   operation to verify the two fixed files report their current bounded custody
   state. The qualifier verifies an absent admitted fixture ref and the
   corresponding Worker `WORK_STATE_NOT_FOUND` result without emitting a
   response body or capability.
5. Obtain an independent adversarial review that reruns the trust-root and
   synthetic checks. Only after that may a separate operator-authorized
   real-credential lifecycle probe be considered.

The operation interface is
`sudo -n /opt/nexus-cloudflare-broker/bin/nexus-cf-broker demo-transport` with
one strict JSON request on stdin. It supports only `capability-status`,
`repo-default`, `repo-ref`, `publish-ref`, and `worker-work-state`. It does not accept Git argv, a remote,
URL, credential path, Worker URL, workspace path, or arbitrary ref. See the
module source and its synthetic test for the exact schemas and results.

## Rollback (operator only)

Rollback is intentionally limited to `/opt/nexus-cloudflare-broker` and only
removes it if its installed manifest digest and every object still verify.
After confirming the install bundle's external index digest as above, run:

```sh
sudo /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /bin/bash --noprofile --norc \
  /opt/nexus-cloudflare-broker-bundle/rollback.sh
```

If verification fails, the script refuses deletion; manual operator review is
then required. Rollback does not delete `/home/mike/.local` Node/`cf`,
Cloudflare authentication, or any other service/data.

## Upstream references

- Cloudflare CLI requirements, profile precedence and sign-in:
  <https://developers.cloudflare.com/cf/get-started/>
- Cloudflare CLI environment variables:
  <https://developers.cloudflare.com/cf/environment-variables/>
- Node release signing-key provenance:
  <https://github.com/nodejs/release-keys>
- Node release artifacts:
  <https://nodejs.org/dist/v24.21.0/>
- npm package metadata / registry artifact:
  <https://registry.npmjs.org/cf/1.0.0-beta.10>

The installer assigns a non-secret stage label to each major operation. On a
failure it writes the stage and exit status to a unique root-only diagnostic
directory under `/opt`, preserves only the last 40 lines of the npm install or
signature-audit output, removes the temporary workspace, and reports the
private diagnostic path. It does not use shell tracing or capture the caller's
environment. Successful installation removes the temporary diagnostic
directory.

## Post-contest security maintenance (2026-10-18)

The source manifests override the transitive `sharp` dependency to `0.35.5`, including libvips bundle `1.3.4` and librsvg `2.63.2`, to address GHSA-wq5f-xc86-pv6w. The `cf` runtime remains pinned to `1.0.0-beta.10`; no Cloudflare CLI feature upgrade is included. Both affected lockfile trees are patched.

The installation manifest was regenerated on mike-dev using the pinned, signature-verified Node archive, npm registry signature verification, and a credential-free CLI version check. Bundle hashes and candidate-manifest constants were refreshed. This is source maintenance, not deployment or live-broker qualification. The existing prior-install allowlist and rollback history remain unchanged; an installed host outside that allowlist requires a separately reviewed migration before applying this recipe. The submitted revision is retained in Git history.
