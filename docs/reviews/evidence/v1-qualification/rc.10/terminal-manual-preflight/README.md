# RC10 desktop manual-terminal preflight

**Disposition:** installation preflight passed; manual terminal qualification has not started. **0/15 cells are complete.** This record is not human terminal acceptance.

## Candidate and installer identity

- Release: [`v1.0.0-rc.10`](https://github.com/mikeholownych/nexus-code/releases/tag/v1.0.0-rc.10), published prerelease.
- Source commit: `16ee8ca3643824741b6da67936b41f262414fdf0`.
- Linux x86-64 archive SHA-256: `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`.
- Published `install.sh` SHA-256: `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302`; matched the installer at the `v1.0.0-rc.10` tag and the GitHub Release API digest.
- Checksum index SHA-256: `760199fcb7e079b356ddbae4f739c74bc356a7b0a7a2edd956b554736651d8fe`.

## Installation result

On `ubuntu-desktop` (`10.0.8.3`), the official installer ran with `NEXUS_VERIFY_ATTESTATION=1` and a separate prefix:

`/home/mike/.local/nexus-rc10-qualification`

GitHub CLI authentication was available to the installer. It reported successful provenance verification for the archive and checksum index, installed `v1.0.0-rc.10`, and the installed package manifest verified. The installed `.provenance.json` records the full source commit and archive digest above. The version command reported `1.0.0-rc.10 (16ee8ca36438)`.

The existing default Nexus launcher was left unchanged; it still resolves to the RC7 installation. The qualification prefix has its own `bin/nexus` launcher, so this preflight did not switch the user's default version.

## Environment observed

The desktop reports Node.js `v22.22.1`; GitHub CLI authentication succeeded. `xterm`, `kitty`, `gnome-terminal`, `tmux`, and VS Code are installed. The SSH session exposed neither `DISPLAY` nor `WAYLAND_DISPLAY`, so no interactive terminal was launched and no screenshot or manual result was captured.

## Manual matrix ready to run

Use the current [`TERMINAL-MATRIX-WORKSHEET.md`](../../../../../v1.0.0/TERMINAL-MATRIX-WORKSHEET.md) from the Ubuntu/GNOME graphical session. Invoke the isolated RC10 binary by its full path:

`/home/mike/.local/nexus-rc10-qualification/bin/nexus`

The 15 cells are:

| Terminal environment | 80×24 | 40×14 | 200×60 |
|---|---|---|---|
| xterm | Not run | Not run | Not run |
| kitty, keyboard protocol enabled | Not run | Not run | Not run |
| tmux 3.x inside GNOME Terminal | Not run | Not run | Not run |
| VS Code integrated terminal | Not run | Not run | Not run |
| GNOME Terminal | Not run | Not run | Not run |

For each cell, perform all seven checks in `ACCEPTANCE.md` §5.3: launch; exercise the approval panel with continuous typing and a three-line paste before a deliberate approval; use Shift+Enter or Alt+Enter for multiline input; resize while streaming; press Esc during `sleep 30` and confirm no survivor; press Ctrl-C twice and confirm clean terminal restoration; and verify `NO_COLOR`. Save the approval-panel and post-exit screenshots and record a PASS/FAIL verdict. A failure on approval input, cancellation cleanup, or terminal restoration fails the safety gate; every other failure needs a documented disposition. Keep failed attempts and retries distinct.

No interactive cell was run during this preflight. Until genuine operator evidence is added, the matrix remains **0/15**.
