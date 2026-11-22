# INSTALL_POLICY_01 — installer guardrails

## Problem

`install.sh` is a curl-to-shell installer that writes only under `$HOME`, but four policy gaps could
turn a routine install into a broken installation or a misleading failure:

- `sudo ./install.sh` installed into root's home, so the invoking user could not find `nexus`.
- `INT`/`TERM` during a download used the cleanup trap's status instead of the shell's conventional
  130/143 exit codes, and a trap reset later in the script dropped signal handling entirely.
- A concurrent install could repoint the launcher while `nexus upgrade` still owned the upgrade
  journal, making recovery roll back to the wrong package.
- The rate-limit error recommended `GITHUB_TOKEN`, but no release lookup sent an `Authorization`
  header. The hint was actionable only if the token were wired in, and must never print its value.

## Changes

- Added a sudo guard for `id -u = 0` with a non-root `SUDO_USER`, with an explicit
  `NEXUS_INSTALL_ALLOW_SUDO=1` opt-in for intentional root installs. Plain root (containers, CI) is
  unchanged.
- Added `INT → 130` and `TERM → 143` exit traps, re-armed after every trap reset. Cleanup remains on
  `EXIT`/`HUP`, so temporary files are still removed on signal exit.
- Added a read-only upgrade-journal guard before any download or install. A journal in `idle`,
  `complete` or `rolled_back` is allowed; a pending, invalid or redirected journal fails with a
  `nexus upgrade --recover` hint. The guard never writes, renames or deletes the journal.
- Wired `GITHUB_TOKEN` into the two GitHub release lookups through a single `api_get` helper. The
  header is sent only when `NEXUS_RELEASES_API` is unset, so a custom/loopback API cannot harvest the
  token. Tokens with unexpected characters are ignored with a warning that does not echo the value.
  The rate-limit hint now says "when using GitHub's API".

Existing guarantees are untouched: SHA256SUMS, trusted-`gh` attestation, manifest/provenance binding,
journal recovery, and refusal to touch unmanaged paths are all still exercised by the smoke test and
the static regression test.

## Verification

- `npm --prefix cli run build`: pass.
- `cli/test/install_policy.test.ts` (new): 5 tests covering guard order, signal traps and re-arming,
  read-only journal inspection, token handling, and preservation of the existing verification gates.
- `cli/test/install_durability.test.ts`: 2 existing tests still pass.
- `scripts/installer-smoke.sh`: pass end-to-end against a loopback release fixture, including all new
  guardrails (sudo refusal and opt-in, pending- versus closed-journal behaviour, `SIGINT`/`SIGTERM`
  exit codes with default signal dispositions, and token non-disclosure to a custom API).
- `scripts/package-smoke-http.py`: now optionally logs request headers to `NEXUS_HEADER_LOG` so the
  smoke test can assert no `Authorization` header reaches a custom API.

The signal tests launch the installer through a small Python exec shim because an async shell list
inherits `SIGINT` as ignored; without the reset the installer's trap cannot be observed.

## Reference coding

The installer comparison pass queried the local XERJ node and submitted a field report
(`HTTP 200`, `stored: true`). Peer scripts were also read directly from `/tmp/opencode`:

- **Borrowed:** Claude's sudo guard (`claude-install.sh:14-34`): refuse `SUDO_USER` installs into
  root's home, leave plain root alone, provide an explicit opt-in. Reworded for Nexus and tightened
  to require the exact `1` value.
- **Borrowed:** Codex's and OpenCode's signal exits (`codex-install.sh:1334-1335`,
  `opencode-install.sh:337-338`). Unlike those scripts, Nexus re-arms the traps after each `trap`
  reset so a later phase cannot silently drop them.
- **Borrowed:** Codex's practice of deferring to an existing upgrade lock before mutating an install
  (`codex-install.sh`). Nexus already has `.upgrade.lock` and `.upgrade-journal.json`; this slice
  checks the journal read-only rather than adding a second lock protocol.
- **Rejected:** OpenCode's checksum-free installer path and Goose's silent fallback to the latest
  tag: Nexus keeps SHA256SUMS, trusted-`gh` attestation, and an explicit `NEXUS_VERSION` hint.
- **Rejected:** Goose's environment dumps and default shell-profile writes: the token fix prints no
  value, and PATH guidance remains a non-mutating suggestion.
- **Rejected:** Codex's aggressive old-release pruning; the installer keeps intact version
  directories for rollback and only re-extracts when the recorded digest no longer matches.

## Deferred

- Byte-level download progress (`cli/src/upgrade.ts`), tracked as the second PR in this sequence.
- A live rate-limit fixture against `api.github.com` with a real token; current evidence is the
  loopback non-disclosure check plus the static header assertions.
