# DEFECT: required provenance attestation was skipped when `gh` was missing or PATH-shadowed

| | |
|---|---|
| Base revision | `19b30a4c92b8dd2c891c5b7a5b67db319ee9ee7f` (`origin/main`) |
| Branch | `v1/defect-upgrade-attestation` |
| Affected behavior | With `NEXUS_VERIFY_ATTESTATION=1`, upgrade only ran attestation when `spawnSync("gh", ["--version"])` succeeded. If `gh` was absent (or a PATH shim failed the probe), the whole block was skipped and the upgrade proceeded as verified—fail-open. Because `gh` was resolved from PATH, a shim that exits 0 for the probe and both `gh attestation verify` calls could also claim verification without a real check. |
| Severity | Medium: an explicitly required supply-chain proof could be silently omitted or spoofed during upgrade. |

## Reproduction (pre-fix)

The new acceptance test uses the existing local release server, sets `NEXUS_VERIFY_ATTESTATION=1`, and puts a `gh`
shim that exits 0 first in `PATH`. On the base source `performUpgrade` succeeded with no rejection:

```
✖ refuses an upgrade that requires attestation when gh is unavailable
  AssertionError: Missing expected rejection: a required attestation must fail closed when gh is missing
```

The same happens with `gh` absent entirely (empty PATH): the probe fails and the required check is skipped.

## Fix

Resolve `gh` only at trusted system paths (`/usr/bin/gh`, `/usr/local/bin/gh`), never from `PATH`. If verification is
required and no trusted `gh` exists, fail the upgrade with an explicit error. The default `auto` mode still skips when
`gh` is absent, as before; a trusted `gh` that reports a failed attestation still fails when required.

## Verification

- New acceptance test (`refuses an upgrade that requires attestation when gh is unavailable`) injects an empty
  trusted-path list, puts a marker-writing `gh` shim in PATH, and asserts the exact “no trusted GitHub CLI” error
  plus that the shim never ran. It fails on the base source (upgrade succeeds through the PATH shim) and passes after;
  this host has `/usr/bin/gh`, so the injection is what makes the test pin the missing-trusted-binary branch rather
  than the pre-existing attestation-failure branch.
- The required-attestation precondition is checked before the journal/download transaction, so it fails fast without
  leaving a `recovery_required` journal.
- Full `upgrade_acceptance.test.ts` 7/7; `npx tsc --noEmit`; `git diff --check`.
- No network/production state is used: the existing mock release server provides the archive, checksums and
  compatibility metadata, and the injected empty trusted-path list means `gh` is never spawned.

## Residual risk

- `gh` outside the two trusted paths (Homebrew, snap, nix, custom prefix) is no longer used. In `auto` mode this is a
  deliberate tightening but also a behavior change: those hosts silently skip attestation where they previously
  verified it. With `NEXUS_VERIFY_ATTESTATION=1` the upgrade fails closed, so they must install `gh` at a trusted path
  or opt out explicitly.
- `install.sh` still has the original fail-open pattern: it resolves `gh` with `command -v gh` and skips the whole
  block when absent, even with `NEXUS_VERIFY_ATTESTATION=1`. Fixing the installer is a follow-up outside this CLI
  slice; it is not claimed fixed here.
- The trusted `gh` binary is assumed provisioned by the OS/package manager; trusted paths are checked with
  `existsSync` (symlinks are followed) and ownership/executability are not independently verified.
- Attestation remains optional by default (`auto`).
