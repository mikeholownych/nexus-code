# DEFECT: release extraction trusts ambient `PATH` and `TAR_OPTIONS`

| | |
|---|---|
| Base revision | `4b474f1638645258fc6bc696400892feaf3a78d6` (`origin/main`) |
| Branch | `v1/defect-tar-ambient-env` |
| Affected behavior | `safeExtractTar` ran `spawnSync("tar", …)` with the inherited environment. A `tar` earlier in `PATH` (for example a workspace directory added to `PATH`) was executed instead of the system tar, and an ambient `TAR_OPTIONS` such as `--to-command=…` or checkpoint actions could execute commands during extraction. The archive itself may be signed/verified; this path bypassed that by turning ambient configuration into code execution during `nexus upgrade`. |
| Severity | Medium: upgrade-time arbitrary command execution from ambient environment/PATH, including when the upgrade runs with elevated privilege. |

## Reproduction (pre-fix)

The new tests build a valid release archive, then:

1. put a wrapper `tar` first in `PATH` that touches a marker and delegates to `/usr/bin/tar`;
2. put a wrapper `gzip` first in `PATH` that touches a marker and delegates to the system `gzip`
   (system tar resolves its decompressor through `PATH`);
3. set `TAR_OPTIONS=--to-command=<script>` where the script touches a marker.

Pre-fix results:

```
✖ does not resolve tar from PATH
  AssertionError: tar was resolved from PATH
✖ does not resolve the decompressor from PATH
  AssertionError: tar resolved its decompressor from PATH
✖ does not honor ambient TAR_OPTIONS during extraction
  AssertionError: ambient TAR_OPTIONS executed a command during extraction
```

The PATH wrapper test still extracted the tree, so it does not rely on a failed extraction. The
`TAR_OPTIONS=--to-command` case ran the marker command and produced no extracted package at all: the
pre-fix probe therefore also lost the extraction, not just executed code; the test records the marker before
re-throwing extraction failure.

## Fix

Resolve `/usr/bin/tar` or `/bin/tar` explicitly and fail closed when neither exists (no `PATH` fallback), then run
extraction with `PATH: "/usr/bin:/bin"` and `TAR_OPTIONS: ""`. The fixed tar therefore also resolves its gzip
decompressor from trusted system directories rather than from ambient `PATH`; ambient tar options cannot run
commands.

## Verification

- `cli/test/tar_safety.test.ts`: the three ambient-environment tests (PATH tar, PATH gzip, TAR_OPTIONS) fail on the
  base source and pass after the change; existing symlink-confinement tests still pass. The suite reports 7/7 with
  explicit skips only when no system tar/gzip is installed.
- `npx tsc --noEmit`; `git diff --check`: pass.
- The pre-fix marker checks are the regression signal; no assertions were weakened.

## Residual risk

- Upgrade is Linux-only and now fails closed if neither `/usr/bin/tar` nor `/bin/tar` exists; a minimal host must
  provide the system tar. Tests skip explicitly on a host without one rather than passing silently.
- `upgrade.ts` still resolves the `gh` attestation helper from ambient `PATH` with the inherited environment; a PATH
  shim can influence or suppress attestation verification (it fails open). That is a separate follow-up, not fixed
  here.
- Other extraction helpers or external commands are outside this slice; the archive remains checksum/attestation
  verified before extraction.
