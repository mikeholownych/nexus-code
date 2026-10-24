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
2. set `TAR_OPTIONS=--to-command=<script>` where the script touches a marker.

Pre-fix results:

```
✖ does not resolve tar from PATH
  AssertionError: tar was resolved from PATH
✖ does not honor ambient TAR_OPTIONS during extraction
  AssertionError: ambient TAR_OPTIONS executed a command during extraction
```

Both markers were created and extraction still completed, so the test is not relying on a failed extraction.

## Fix

Resolve `/usr/bin/tar` or `/bin/tar` explicitly (falling back to `tar` only when neither exists) and run extraction with `TAR_OPTIONS: ""` in the environment. This removes both ambient executable selection and ambient tar options that can run commands.

## Verification

- `cli/test/tar_safety.test.ts`: both ambient-environment tests fail on the base source and pass after the change; existing symlink-confinement tests still pass (6/6).
- `npx tsc --noEmit`; `git diff --check`: pass.
- The pre-fix marker checks are the regression signal; no assertions were weakened.

## Residual risk

- On a platform without `/usr/bin/tar` or `/bin/tar`, the fallback still uses `PATH`; packaged upgrades are Linux-only where one of those paths is expected.
- Other extraction helpers or external commands are outside this slice; the archive remains checksum/attestation verified before extraction.
