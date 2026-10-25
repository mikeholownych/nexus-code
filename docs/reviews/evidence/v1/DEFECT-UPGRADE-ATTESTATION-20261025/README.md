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

- New acceptance test (`refuses an upgrade that requires attestation when gh is unavailable`) fails on the base
  source (upgrade succeeds) and passes after the change with the shim in PATH.
- Full `upgrade_acceptance.test.ts` 7/7; `npx tsc --noEmit`; `git diff --check`.
- No network/production state is used: the existing mock release server provides the archive, checksums and
  compatibility metadata.

## Residual risk

- `gh` outside the two trusted paths (Homebrew, snap, nix, custom prefix) is not used. In `auto` mode attestation is
  skipped as before; with `NEXUS_VERIFY_ATTESTATION=1` the upgrade fails closed, so those installs must install `gh`
  at a trusted path or opt out explicitly.
- Attestation remains optional by default (`auto`), and the trusted `gh` binary itself is not independently verified;
  it is assumed to be provisioned by the OS/package manager.
