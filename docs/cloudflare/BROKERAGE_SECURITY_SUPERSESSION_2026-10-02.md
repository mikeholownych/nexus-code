# Brokerage security supersession — 2026-10-02

## Current disposition

**`BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`**. No real Artifact credential may be
issued. The superseding finding does not alter Git history or the provenance
commit `fb8cc879f0faccfd92b9174a80c34246b72455a5`.

## Superseded claim and provenance check

An earlier recovery report and working-tree qualification note treated
`BROKERAGE_SAFETY_GATE_QUALIFIED` as a synthetic-only qualification. Adversarial
review later found gaps in that gate and the credential helper. That overall
safety-gate claim is superseded by `BROKERAGE_SAFETY_GATE_NOT_QUALIFIED` until a
corrected implementation and tests pass independent review.

At this recovery's starting HEAD, a direct read of the committed
`ARTIFACT_CREDENTIAL_BROKERAGE_GATE.md` showed the independent review was still
pending. The stronger qualification wording was present in subsequent
working-tree/recovery records, not in that committed file. This distinction is
preserved; no reviewer misconduct is implied by the later, deeper findings.
The earlier 25-case synthetic detector result remains historical evidence for
that limited detector matrix. It does not qualify the current credential
broker or authorize real credential use.

## Newly discovered contradictions

Independent source review of helper SHA-256
`7e4c7aac6eb369779db318907a920f7facc3730cbc068bdd0fb3a75e68eca6ff` and test
SHA-256 `75c75569b52206f4ee23c5f06c3321d3338786c33d89e3a96b7d45848d421263`
found:

1. Synthetic Git validation resolved and hashed one path, but execution used
   the original `GIT_CLI_PATH` environment value. A relative value can be
   resolved through `PATH` to another executable.
2. The checked file could be replaced between its hash check and later
   pathname-based execution. Symlink and wrapper rejection did not close this
   time-of-check/time-of-use gap.
3. A create request with a lost, malformed, or unidentifiable response may
   still have created a credential. A failed revoke command does not prove the
   credential remains active or inactive; neither outcome is inferred.
4. The requested token TTL was not verified in metadata or by post-expiry
   authentication. Inventory absence after revoke does not itself prove Git
   authentication rejection. The earlier independent review's statement that
   the service-side TTL bounds process death was a documented assumption, not
   an empirical result, and is superseded here by `TTL_ENFORCEMENT_UNPROVEN`.

Cloudflare's current REST documentation says token `ttl` accepts 60 through
31,536,000 seconds (default 86,400) and that token creation/listing includes
`expires_at`. This is `DOCUMENTED` syntax/metadata, not proof that a configured
expiry is enforced at the Git endpoint. The prior incident requested 900
seconds; this recovery issued no real token. The current helper's 300-second
request is only to a synthetic fake CLI. [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/).

## Security impact

If the Git executable is substituted, it could receive the scoped bearer
credential through the Git configuration environment and expose or misuse it.
If issuance or revocation is ambiguous, the account may retain an unaccounted
credential. The synthetic tests did not establish these cases safely enough to
authorize a live probe. No real Artifact credential was issued during this
recovery, and no Cloudflare mutation occurred.

## Corrective work and remaining gates

A disposable Linux test demonstrated that ordinary pathname-based spawn runs a
replacement executable after validation, while execution through an inherited
`/proc/self/fd/3` descriptor runs the already-open original ELF object. The
broker now uses that descriptor-bound launch path. Independent review found
remaining gaps: an opened inode can still be modified in place; the test does
not qualify shebang interpreters or transitive runtime trust; post-revocation
Git output was not scanned for credential reflection; and cleanup could be
skipped if an earlier cleanup scan threw. The later helper revision adds a
post-revocation reflection check and catches cleanup-scan errors, with
synthetic post-revocation reflection, persistence, unreadable-file cleanup,
and inventory-failure controls. Inventory observations are now tri-state, so
an inventory error remains unknown/ambiguous rather than being reported as
active or revoked; successful revoke-command status is kept separate from
revocation verification. The scan-error test requires an explicit scanner
error witness plus temporary-directory and lock cleanup. A final independent
read-only review confirmed those fixes at helper SHA-256
`9500266eba4f13886e2072dd74c6892d613f79032d7fdaad811500a2f7be4f5e` and test
SHA-256 `492bc7e12821552d3006c9fd9939f65fc6f50f7b35974d6117d1ac550757cdb5`.
The 18-case synthetic suite passed locally; the reviewer did not rerun it.
Overall disposition remains
`BROKERAGE_SAFETY_GATE_NOT_QUALIFIED` because executable immutability and
interpreter/runtime trust, ambiguous issuance cleanup, and TTL enforcement
remain unresolved. The
production `cf` target is a
UID-1000 shebang script with mode `0775`, so the helper correctly rejects it for
group writability before execution. No real token operation can currently run
through this boundary.

The local transcript remediation replaced eight known occurrences, but the
original credential literal was intentionally not retained. Stable sealed
in-memory snapshots verified captured high-water byte ranges and JSONL
structure (the stale descriptor snapshot SHA-256 is
`2789d837e9d31a23947fd7283381b36709a8d8085a7a54f5862070402eecb7ba`, covering
29,910,701 bytes at 2026-10-02 11:06:03 UTC). The app-server still held the
unlinked transcript open for append. The exact-match count is therefore
`UNKNOWN`; the snapshots cannot reconstruct the absent literal or cover later
appends. See the remediation companion for both snapshot ranges and limits.

Required before any credential issuance:

- close the independent-review findings for descriptor-bound execution and
  approved executable trust, and independently review current cleanup/output
  fixes; current disposition remains `BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`;
- bind validation to immutable approved executable contents and qualify the
  interpreter/runtime chain, or keep real operations unavailable;
- independently qualify cleanup exception and inventory-error injection;
- reconcile ambiguous issuance without revoking unrelated tokens;
- demonstrate revocation through inventory and, if safely possible, Git
  authentication rejection;
- keep TTL enforcement classified `TTL_ENFORCEMENT_UNPROVEN` until an empirical
  expiry test is independently authorized and completed;
- plaintext-remediation status at the time of this earlier checklist was
  unresolved; the operator later dispositioned the incident as
  `CONTAINED_WITH_RESIDUAL_RETENTION_UNKNOWN`, with known local copies
  remediated in the bounded recorded scope. Do not recover the secret or treat
  global/local exact-match absence as a credential gate.

No E3 or E3R execution occurred during this security recovery.

## Experiment terminology reconciliation

- **`E3_ORIGINAL_STATUS=EXPERIMENT_3_CORRECTION_REQUIRED`.** This is the
  earlier README-only producer/update trial. Its independent review confirmed
  protocol-order deviation and no demonstrated collaboration advantage.
- **`E3R_STATUS=E3R_QUALIFIED_DIRECTIONAL_RESULT`.** E3R is a distinct,
  preregistered stale-interface contract-refactor trial with its own three-run
  evidence and independent review. Its harness uses a local temporary Git
  origin and local Git pushes; source inspection found no Cloudflare CLI,
  Artifact token, or network operation in that harness. The current brokerage
  findings therefore do not invalidate E3R's bounded local integration
  observations. They do not widen E3R's result beyond its fixture or qualify
  credential handling. Neither E3 nor E3R was rerun here.

## Current execution trust-root assessment — 2026-10-02

**Disposition: `BROKER_EXECUTION_TRUST_ROOT_NOT_QUALIFIED`.** The completed
independent reviewer reran the current local synthetic checks but did not
authorize live issuance. No Cloudflare command that creates, lists, or revokes
credentials was run in this assessment.

### Observed trust graph

The locally resolved `cf` command is a symlink at
`/home/mike/.local/node-v24.11.1-linux-x64/bin/cf` (owner UID/GID 1000, symlink
mode 0777) to
`/home/mike/.local/node-v24.11.1-linux-x64/lib/node_modules/cf/bin/cf` (regular
file, UID/GID 1000, mode 0775). The target begins with `#!/usr/bin/env node`.
`/usr/bin/env` is root-owned mode 0755; its `node` choice is controlled by
`PATH`. Under the ambient path, `node` resolves to a user-owned Node 24.11.1
binary, mode 0755. `/usr/bin/node` is root-owned mode 0755 but is Node 20.20.2;
this installed `cf` requires Node 22 or newer, so the system runtime is not a
working approved substitute.

The CLI package entry dynamically loads `../dist/delegate.mjs` and
`../dist/index.mjs`. The observed package `bin`, `dist`, `node_modules`, and
package directories are user-owned and mode 0775; the independent scan found
291 `dist` files and 2,013 dependency files user-owned/writable. The delegate
code reads the current working directory, resolves a local `cf` package, and
can delegate to that local install. The CLI and runtime also have environment
and home/config resolution inputs. Thus the security-relevant chain is:

```text
caller PATH / startup environment / cwd
  -> user-mutable cf symlink
  -> user-owned group-writable cf shebang script
  -> /usr/bin/env selects Node through PATH
  -> user-owned Node 24 runtime
  -> user-owned writable cf dist modules and npm dependency tree
  -> cwd-sensitive delegation and HOME/XDG/config/environment behavior
```

`strace` of an isolated `cf --help` invocation (no authenticated operation)
observed the script execution, `/usr/bin/env` runtime lookup, and module opens
under the package `dist` tree. It exited successfully with the user Node 24
runtime. A sanitized PATH containing only `/usr/bin:/bin` instead selects
`/usr/bin/node` 20.20.2, and the CLI rejects that runtime as too old. These are
local observations about this installation, not Cloudflare service behavior.

### Caller environment boundary

The helper now constructs a fixed environment for its child `cf` and Git
processes and runs the CLI with `/` as working directory. It does not inherit
`NODE_OPTIONS`, `NODE_PATH`, npm configuration variables, or the caller's
`PATH`; its synthetic tests verify those child-process constraints. However,
this filtering occurs only after the helper's Node process has started. A
synthetic `NODE_OPTIONS=--require=<fixture>` probe demonstrated that Node loads
the preload before executing the helper entry point. Starting the helper via
`/usr/bin/env -i ... /usr/bin/node ...` prevented that fixture from loading,
but no trusted, enforced launcher currently guarantees that clean startup in
the production call path. Therefore the caller can still affect broker startup
through Node's pre-entry injection surface unless an upstream trusted launcher
is established.

### Trust policy and decision

The minimum policy for an approved executable chain requires fixed absolute
object identity; regular files with an explicit symlink policy; trusted owner;
no caller/group/other write authority; non-writable parent directories that
prevent replacement; and runtime/module resolution bound to approved objects.
A content digest can add identity evidence but cannot compensate for caller
write authority. The current `cf` target fails the writable-object rule, its
runtime and module tree are mutable by the caller, and the Node process startup
environment is not bound by an enforced clean launcher. The descriptor-bound
ELF fixture only closes pathname replacement for that opened ELF object; it
does not establish trust in this shebang/runtime/module chain or protect an
opened inode from in-place modification.

No available installation satisfies this policy. No chmod/chown, system
installation, privilege change, or substitute live API path was attempted.
The smallest defensible disposition is to refuse real credential issuance
until a caller-independent trusted launcher and immutable/approved CLI runtime
and dependency objects are available and independently tested. This is an
environmental/trust-root blocker, not evidence that Cloudflare's token API is
unsafe.

### Final synthetic review and remaining lifecycle gates

The independent reviewer reran six Node syntax checks, 20 lifecycle assertions,
the five-check descriptor execution fixture, and 18 synthetic broker cases
plus four mode/path boundaries. All passed; no Cloudflare mutation occurred.
The reviewer also confirmed that passing those tests does not qualify the
production executable chain. Synthetic-only tests cannot prove live issuance,
inventory reconciliation, credential usability, revocation, or post-revocation
Git rejection. Those remain untested. TTL remains
`TTL_ENFORCEMENT_UNPROVEN`; no real credential was issued and no TTL probe was
performed.

In a separate independent startup-boundary probe, a harmless temporary
`NODE_OPTIONS=--require=<marker>` preload executed before the helper rejected
an invocation without explicit mode. With an explicit `env -i` environment,
the preload did not execute. The helper has no enforced clean launcher before
its Node process starts; the helper's child environment allowlist is therefore
too late to close this caller-controlled startup channel. This directly
confirms why passing the current 18-case suite is insufficient: its benign
Node-options case checks child execution only and does not test helper startup.
The independent reviewer confirmed the current helper and test hashes match
disk and retained `BROKERAGE_SAFETY_GATE_NOT_QUALIFIED`.

Incident status remains `CONTAINED_WITH_RESIDUAL_RETENTION_UNKNOWN`: known local
copies were remediated in the documented bounded scope; other local or external
retention was not proven absent. No plaintext was reconstructed or searched
outside that bounded evidence. E3 remains
`EXPERIMENT_3_CORRECTION_REQUIRED`; E3R remains
`E3R_QUALIFIED_DIRECTIONAL_RESULT` in its bounded fixture. Neither was rerun.
