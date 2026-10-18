# PLAN-06: Packaged product parity, launcher, versioning and diagnostics

Implements [SPEC-06](../specs/SPEC-06-packaged-product-parity.md). This is milestone **M0** for the versioning work (tasks 3 and 4) and **M2** for the rest.

- Requirements: REQ-REL-101 to 105, REQ-DX-101 to 104.
- Decisions: DEC-02, DEC-08, DEC-14.

## Safe change boundary

- `cli/src/index.ts`
- `harness.sh`
- `scripts/package-linux.sh`
- `scripts/smoke-package.sh`
- `scripts/installer-smoke.sh`
- `install.sh`
- `core/src/bin/nexus_tui/live.rs:126-131`
- `core/src/bin/nexus_tui.rs` (add `--check`)
- `core/Cargo.toml`
- `package.json`
- `cli/package.json`
- new `scripts/sync-version.mjs`
- `.github/workflows/release.yml`
- `cli/src/doctor.ts`
- `core/src/main.rs` (`hello` RPC)
- `cli/src/tools.ts` (handshake)

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | Default action: on a TTY with nexus-tui resolvable, spawn `nexus-tui --live --sidecar <resolved> --node process.execPath -- …` with inherited stdio and exit with its code; otherwise use the REPL with a notice. Add global flags `--repl`, `--live`, `-r/--resume [id]`, `--approve`, `--yes`. Set `program.name("nexus")`. | `index.ts:60-120,745-757` | — |
| 2 | `nexus-tui` sidecar resolution order: flag → `$NEXUS_HOME/lib/cli/dist/sidecar.js` → checkout. The error lists the paths tried. Add `--live --check`, which resolves and exits. | `live.rs:126-131`; `nexus_tui.rs` | — |
| 3 | `scripts/sync-version.mjs` writes `package.json` → `cli/package.json` + `core/Cargo.toml` (and `Cargo.lock` via `cargo update -p harness-core --offline`). Run it now to set Cargo to `0.1.0-alpha.2`. The release workflow asserts equality with the tag. | new script; `core/Cargo.toml:3`; `release.yml:27-31` | — |
| 4 | `hello` RPC: harness-core returns `{version, protocol}`; the bridge checks both on start; a mismatch gives one actionable error. Coordinate the protocol number with PLAN-02. | `main.rs`; `tools.ts` start | 3 |
| 5 | Reduce `harness.sh` to an exec of node (checkout mode). Unknown subcommands error (commander default). | `harness.sh` | 1 |
| 6 | Doctor: remove listeners; packaged remedies; path-safe redaction; `config.env` permission check + repair; `tui.launch` via `nexus-tui --live --check`. | `doctor.ts:103-110,316,332,492,517-529,644,751,757` | 2 |
| 7 | Installer: strict tag regex; `-fsSL --show-error`; no-stable-release hint naming the latest prerelease; rate-limit message; `MANIFEST.sha256` repair on reinstall; `NEXUS_FORCE=1`. | `install.sh:21-49`; `package-linux.sh` (write manifest) | — |
| 8 | Package smoke: PTY launch of the installed `nexus` asserts the TUI header (ACC-PKG-01); doc-command extraction test (ACC-PKG-02); doctor stderr empty (ACC-PKG-06) and remedy grep (ACC-PKG-07). | `scripts/smoke-package.sh`; new `scripts/doc_commands.mjs`; `cli/test/harness_entry.test.ts` | 1,6 |
| 9 | Docs: USER_MANUAL launch section; quickstart; CLIENT_GUIDE; release notes (no-arg launches TUI; explicit `run` for free text). | docs | all |

## PR slices

1. **PR-6a (M0):** task 3 (version sync, plus the CI assertion). Owner action X1 (delete stale tags) is already complete.
2. **PR-6b:** tasks 1, 2, 5 (unified launcher).
3. **PR-6c:** task 4 (handshake), together with PLAN-02 PR-2b.
4. **PR-6d:** task 6 (doctor).
5. **PR-6e:** task 7 (installer).
6. **PR-6f:** tasks 8, 9 (smoke tests and docs).

## Tests

| Test | Covers |
|---|---|
| `harness_entry.test.ts`: argv routing table; non-TTY → REPL; unknown command error | ACC-PKG-04 |
| `doctor.test.ts` extensions | ACC-PKG-06 to 09 |
| `installer-smoke.sh` additions: bad tag, no-stable hint (mock API via `NEXUS_RELEASES_API` override used only in smoke), manifest repair | ACC-PKG-05 |
| `smoke-package.sh`: PTY launch via `script -qec` and an assert on the header string | ACC-PKG-01 |
| `release.yml` negative check: a job step runs `sync-version.mjs --check` and fails on mismatch | ACC-PKG-03 |

## Rollback

- PR-6b is the behaviour change for the packaged default. Reverting it restores the REPL default.
- The version sync is a pure metadata change.

## Definition of done

- ACC-PKG-01 to ACC-PKG-09 pass.
- A fresh install of the RC shows no doctor warnings on a configured host.
- The installed `nexus` opens the TUI.
