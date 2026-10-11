# Brokerage trust-root construction: bounded decision and install gate

Date: 2026-10-02  
Baseline: `fb8cc879f0faccfd92b9174a80c34246b72455a5`  
Disposition: `BROKERAGE_SECURITY_BLOCKED_OPERATOR_INSTALL`

No credential operation, privileged installation, or experiment was run. This
record compares the two requested trust-root options using local filesystem
observations and current Cloudflare documentation.

## Established constraint

The Node broker cannot sanitize the environment before its own startup. A
separate harmless probe and independent rerun demonstrated that inherited
`NODE_OPTIONS=--require=...` executes its preload before broker JavaScript. A
clean `env -i` launcher prevents that preload, but no such trusted launcher is
currently installed or enforced. The current `cf` script, Node runtime, and
package tree are caller-writable; see the trust graph in
`BROKERAGE_SECURITY_SUPERSESSION_2026-10-02.md`.

## Option comparison

| Property | Option A: trusted launcher → Node 24 → pinned `cf` | Option B: trusted helper → Artifacts REST |
|---|---|---|
| Startup boundary | Requires a static/system-owned launcher to clear the environment before Node starts. | Also requires a static/system-owned launcher before the helper runtime starts, unless the helper is a suitably static ELF. |
| Trusted objects | Launcher, Node runtime and its shared libraries, broker JS, `cf` entrypoint, package tree, and relevant parent directories. Current `cf` package reports 7 direct dependencies; the installed tree contains thousands of files. | Launcher, system Python 3.12 runtime/shared libraries/stdlib, one small root-owned helper, CA trust data, and parent directories. Current Python and stdlib are root-owned and non-user-writable. |
| Caller-writable current components | All existing Node/`cf` objects under `~/.local`; unusable as trusted objects. | Existing caller state is not executable code, but the required API bearer credential source is not established. |
| Secret handling | Existing `cf` auth session can be used without printing an API credential; broker must capture returned repo-token output internally. | REST token creation returns plaintext in JSON. Helper can capture/parse it internally, but it first needs an API bearer token. The documented API uses `Authorization: Bearer $CLOUDFLARE_API_TOKEN`. |
| Ambiguous issue/revoke reconciliation | Can call `cf` inventory and revoke commands; requires parsing their output and testing their error semantics. | REST documents token inventory, create, and revoke routes directly; the helper must handle lost/malformed responses and inventory reconciliation. |
| Runtime/module surface | Significantly larger and more mutable objects to pin and review. | Smaller implementation using Python standard library, but bespoke REST/auth/error handling is required. |
| Contest maintainability | Lowest behavior change because it retains the supported CLI and existing login; higher supply-chain review burden. | Small code surface; adds a distinct API-token provisioning and maintenance path not currently available to the broker. |

### Assessment

Option B is the smaller code/runtime trust root in principle. Current system
Python is `/usr/bin/python3.12`, UID/GID 0, mode 0755; its stdlib is under
root-owned `/usr/lib/python3.12`. A static launcher could establish an empty
environment, fixed cwd and fixed executable before Python starts, then invoke
a root-owned, isolated helper with `-I -S`. However, no directly usable,
non-agent-visible Cloudflare API bearer credential source has been established
for that helper. Extracting auth through the current mutable `cf` installation
would reintroduce Option A's untrusted chain; asking an agent-visible process
to supply the API token would violate the credential boundary. Provisioning a
new control-plane credential and protected source requires operator action.
An unprivileged helper running as UID 1000 also cannot make a file readable to
itself but inaccessible to other processes with the same UID. A protected
service identity or another explicit secret-delivery boundary would therefore
be needed if Option B is expected to keep the control-plane credential from
the caller; that identity/boundary is not designed or installed here.

Independent review inspected the Python interpreter and examined 926 stdlib
objects, all root-owned and non-user-writable. This is ownership/mode evidence,
not complete dependency provenance: native extensions, shared-library
resolution, symlink targets and CA trust data still require an install-time
manifest and verification. The direct API bearer-auth fact above is from the
current Cloudflare REST documentation, not an empirical request.

Option A can reuse the already configured `cf` authentication flow without
introducing a new API token, but it requires a larger independently pinned
installation. It must include a static native launcher, dedicated trusted
Node >=22, a pinned `cf` package and complete dependency tree, the broker
entrypoint, and all non-writable parent directories. The current user-owned
Node/`cf` files cannot simply be chmodded or copied and treated as trusted; the
installation must establish provenance from verified upstream artifacts and
prevent subsequent replacement by UID 1000.

Neither root has been constructed here. Option B is the smaller candidate if
the operator provisions a suitable API-token source; Option A is the
lower-behavior-change candidate if the operator prefers the existing `cf`
login and accepts the larger pinned tree. This is not a qualified selection.

## Operator installation gate

Operator action is required before a valid startup-injection or mutation-denial
test can run against the actual trusted boundary. No privileged command was
run. The installer must establish one of these complete roots, not just a
binary:

### A. CLI-backed root

Install under a root-owned path such as `/opt/nexus-artifact-broker/`:

- a statically linked launcher, owned `root:root`, mode 0755, which accepts
  only a fixed broker operation, calls `clearenv()`, sets a minimal fixed
  environment and cwd `/`, and `execve()`s fixed absolute runtime/entrypoint
  paths;
- a Node >=22 runtime from an upstream signature/checksum-verified release;
- `cf` version `1.0.0-beta.10` (the locally installed package metadata), plus
  lockfile-pinned dependency versions and registry integrity values;
- broker JavaScript and all package/module files, root-owned and not
  group/other writable;
- root-owned, non-writable parent directories for every listed object;
- post-install manifest recording absolute paths, versions, owner/mode, and
  SHA-256 digests, verified as the normal Nexus user.

Do not install the current `~/.local` objects as trusted inputs without
independent upstream provenance verification. Do not use `chmod` on those
files as a substitute for ownership and protected parent directories.

### B. REST-backed root

Install the static launcher and one isolated root-owned helper using the
system Python 3.12 standard library (`-I -S`), with fixed HTTPS host/path,
certificate verification, response-size/time limits, and no shell or `curl`
command construction. Separately provision a least-authority Cloudflare API
token through an operator-controlled protected source that is not exposed to
agent-visible environment, argv, files, or output. Its provisioning and
rotation policy must be reviewed before the helper can be used. The helper
must implement only create/list/revoke and preserve ambiguous lifecycle states.

No exact install command is safe to execute or publish as a ready-to-run root
script until an option and its credential source are selected and the launcher
and broker files have been independently reviewed. No source file is
represented as a qualified installer by this document.

This is a genuine `OPERATOR_INSTALL_REQUIRED` boundary, not a claim that
credential-free source cannot be staged. The exact privileged installation
commands are intentionally not issued as a generic copy/paste script because
the install target, selected option, signed runtime artifact, package lock and
authentication source have not been fixed or independently qualified. The
operator action is to select/authorize a protected install root and its source
artifacts; then a concrete staged bundle and digest-checked install command
must be reviewed before any privileged execution.

## Required post-install gates

After operator installation, and before real token creation:

1. Independently verify ownership/mode/digests and parent-directory protection
   for every trusted object from the unprivileged Nexus account.
2. Run the hostile `NODE_OPTIONS`, `NODE_PATH`, `PATH`, cwd, loader and module
   redirection tests through the installed entrypoint; prove no preload or
   substitute marker executes and prove the intended implementation ran.
3. Attempt harmless mutation/replacement of launcher, runtime, modules and
   parent directories as the normal user; every attempt must be denied.
4. Independently rerun all final synthetic broker/lifecycle cases against the
   selected final implementation.
5. Only after both trust-root and synthetic-gate dispositions qualify may a
   single real lifecycle probe be considered.

The Cloudflare REST documentation currently describes the API base route,
Bearer authentication, token inventory, token creation, and revocation. It
documents creation TTL syntax/metadata, not empirical expiry enforcement.
`TTL_ENFORCEMENT_UNPROVEN` remains. [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/).

## Preserved statuses

- Incident: `CONTAINED_WITH_RESIDUAL_RETENTION_UNKNOWN`.
- Original E3: `EXPERIMENT_3_CORRECTION_REQUIRED`.
- E3R: `E3R_QUALIFIED_DIRECTIONAL_RESULT` within its recorded fixture.
- No E3/E3R rerun, real credential, Cloudflare mutation, privileged action,
  commit, push, tag, or remote creation occurred.
- Current security status: `BROKERAGE_SECURITY_BLOCKED_OPERATOR_INSTALL`.

## Superseding pre-install bundle preparation

The earlier statement that there was not yet a concrete install bundle is
superseded by the staged, **not installed** package at
`experiments/cloudflare-artifacts-vertical-slice/trusted-broker-bundle/`.
This is a new pre-install deliverable; it does not change the trusted Git
baseline, install anything, issue a credential, or qualify a real credential
broker.

The bundle pins Node `v24.21.0` using the official signed checksum file and
pins `cf@1.0.0-beta.10` plus its complete npm lock closure. Its manifest is
host-specific and enumerates each staged object, ownership/mode/digest, and
Node's resolved system runtime libraries. The root-only installer is
side-by-side at `/opt/nexus-cloudflare-broker`, refuses replacement, verifies
the bundle before installation, disables npm lifecycle scripts, verifies npm
signatures, normalizes permissions, and verifies the staged/final tree. It
has not been executed.

Current caller install and auth locations were inspected without reading
authentication file contents: Node `v24.11.1`; `cf@1.0.0-beta.10`; default
profile metadata path `/home/mike/.config/cloudflare/config/default.json`
(mode 0600), state path `/home/mike/.config/cloudflare/state.json` (mode
0600), and update-check cache. These paths are user-scoped state and are not
copied. Cloudflare's docs say `cf` uses the default profile after
`cf auth login`, and that `CLOUDFLARE_API_TOKEN` overrides profiles. The
launcher clears that environment variable and fixes HOME/XDG config paths.
Whether the clean-start protected CLI can authenticate has not yet been
observed; the post-install `auth-check` is a hard gate and emits only status.

Important authority limitation: the CLI profile stays readable to the same
UID that invokes the launcher. This bundle establishes a protected code and
runtime chain; it does **not** provide Unix identity separation or prevent a
same-UID process from invoking the saved `cf` profile directly. Do not treat
it as isolation from a malicious process running as `mike`.

The bundle additionally contains unprivileged post-install qualification and
rollback instructions. The launcher test currently passes its synthetic
negative controls for inherited Node require/import hooks, `LD_PRELOAD`, PATH
shadow, cwd/env reset, and arbitrary-argument rejection. This is only local
source/test evidence. No actual protected installation, auth check, mutation
denial against installed files, or independent bundle review has yet occurred.
