# RC3 desktop setup and installed identity check

Observed at `2026-10-24T01:35:53Z` on `ubuntu-desktop` (`10.0.8.3`) over SSH. This is coordinator-recorded host metadata; it is not an independent custody attestation and does not count as a manual terminal result.

## Installed candidate identity

- Installer prefix: `/home/mike/.local/nexus-candidates/rc3`
- Version output: `1.0.0-rc.3 (1b9791f07d30)`
- Full source revision from installed `.provenance.json`: `1b9791f07d301c885fe48f04a796203583ab5a5c`
- Published archive from installed `.provenance.json`: `nexus-linux-x86_64-v1.0.0-rc.3.tar.gz`
- Published archive SHA-256 from installed `.provenance.json`: `efb446d2760f2e1aa7890e9d786b8a2ba8e4ebb784fbcac1e66afe827428864d`
- Installed manifest: all 273 entries in `MANIFEST.sha256` passed `sha256sum -c --quiet`.
- Launcher SHA-256: `320d7dc1603d30f863a9560a9101ab3fe1a57f164b7119c49e01d9ace40792c4`

The manifest check covers installed-file integrity against the installed manifest. The archive digest above is provenance metadata; this check did not download or independently re-hash the published archive.

## Desktop and terminal setup

- OS/session observed: Ubuntu 26.04.1 LTS, GNOME Shell 50.1, Wayland desktop session active.
- xterm: `XTerm(407)`
- kitty: `0.45.0`
- tmux: `3.6`
- VS Code: `1.143.1`
- GNOME Terminal: `3.58.0` using VTE `0.84.0`
- Setup processes observed: xterm, kitty, GNOME Terminal server with a tmux session, and a VS Code window opened on the evidence directory.
- Worksheet: `/home/mike/nexus-rc3-terminal-evidence/TERMINAL-MATRIX-WORKSHEET.md`; SHA-256 `9838bfbc3e1363e004a814c4035fa046fb378d18b1c6a961ae891712c5c8285b`.
- Screenshot directory count: `0`.

## Disposition

Setup and installed identity were verified. No Nexus interactive matrix session was run. All 15 terminal/size cells remain unrun; there are no verdicts or screenshots. This record does not establish interactive behavior, RC acceptance, or release readiness.
