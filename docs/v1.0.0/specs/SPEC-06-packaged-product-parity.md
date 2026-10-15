# SPEC-06: Packaged product parity, launcher, versioning and diagnostics

| | |
|---|---|
| Status | Ready. Versioning per DEC-08; the REPL stays supported and top-level flags are implemented (DEC-02); explicit `run` is required for free text (DEC-14). |
| Release class | **BLOCKER**: packaged TUI default, documented commands work, single version identity. RELEASE-REQUIRED: launcher routing, doctor fixes, installer messaging. |
| Requirements | REQ-REL-101, REQ-REL-102, REQ-REL-103, REQ-REL-104, REQ-REL-105, REQ-DX-101, REQ-DX-102, REQ-DX-103, REQ-DX-104 |
| Findings | REL-01, TUI-04, REL-02, TUI-05, HIST-06 (commands), REL-03, REL-04, DX-01, DX-02, DX-03, DX-04, DX-05, REL-08, REL-10, REL-11, REL-12, MNT-04 |
| Plan | [PLAN-06](../plans/PLAN-06-packaged-product-parity.md) |
| Acceptance | ACC-PKG-01 to ACC-PKG-09 |

## 1. Problem

The product that users install is not the product that is developed and tested.

**Two launchers.** The developer launcher is `harness.sh` (on this host, `/usr/local/bin/nexus`). With no arguments on a TTY it starts the Ratatui live TUI. The packaged launcher `bin/nexus` (`scripts/package-linux.sh:24-30`) is `node lib/cli/dist/index.js "$@"`. With no arguments it starts the readline REPL (`cli/src/index.ts:747-749`).

**The packaged TUI is unreachable.** No command reaches the TUI. `nexus --live` returns "unknown option". The packaged `lib/core/nexus-tui --live` fails with "sidecar not found" because it assumes the checkout layout (`core/src/bin/nexus_tui/live.rs:126-131`). Doctor nevertheless reports `PASS tui.build` (REL-01, TUI-04, DX-05; RUNTIME). The ISSUE12 requirement UI-004 ("the TUI is the default interactive surface") is therefore false for the shipped product.

**Documented commands fail.** `nexus --approve` and `nexus -r` (USER_MANUAL.md:12-26) both fail with "unknown option", on both launchers (REL-02, TUI-05; RUNTIME).

**`harness.sh` turns unknown words into agent runs.** It has a hand-maintained subcommand whitelist that is missing about 13 real subcommands, including `trust`, `flights`, `operation`, `status` and `resume`. An unlisted word becomes `run "$@"`, which is an autonomous edit-capable agent task (REL-03; SOURCE).

**The version identity is split.**
- `core/Cargo.toml` says `1.2.1`; the CLI says `0.1.0-alpha.2`.
- Every fresh install's doctor warns about this and says "Rebuild with `make build`", which a packaged install cannot do.
- Local-only tags `v1.1.0`, `v1.2.0` and `v1.2.1` exist. They are not on origin and are not ancestors of main (REL-04; RUNTIME).
- `nexus --help` prints "Usage: harness" (MNT-04).

**Doctor problems.**
- Every run prints a `MaxListenersExceededWarning` (DX-01).
- In the package, some remedies point at `harness.sh` or `make` (DX-02).
- Workspace paths containing UUIDs are over-redacted (DX-03).
- A world-readable `config.env` holding an API key is not flagged (DX-04).

**Installer issues.**
- The no-version path fails opaquely while only prereleases exist (REL-08).
- A reinstall cannot repair a damaged version directory (REL-10).
- Version validation is loose (REL-11).
- Progress meters are noisy (REL-12).

## 2. Requirements

1. **REQ-REL-101.** One launcher implementation for the package and the checkout. With no arguments on a TTY it opens the live TUI. With no TTY, or with `nexus repl`, it opens the REPL. The packaged `nexus-tui` locates its sidecar relative to `NEXUS_HOME` (`lib/cli/dist/sidecar.js`).
2. **REQ-REL-102.** Every `nexus …` command line in README.md, quickstart.md, docs/USER_MANUAL.md, docs/CLIENT_GUIDE.md and docs/CLOUD_PROVIDERS.md parses on the packaged install. "Parses" means `--help`, or a dry-safe invocation, exits without "unknown option/command". This is enforced in CI.
3. **REQ-REL-103.** One version: tag == package.json == cli/package.json == core/Cargo.toml == harness-core `--version` == the sidecar protocol's reported core version. Release CI asserts this. A fresh install's doctor shows no version warning.
4. **REQ-REL-104.** An unknown subcommand is an error on every launcher. Free text runs a task only through explicit `nexus run "<text>"`, or through the TUI/REPL prompt.
5. **REQ-REL-105.** The installer:
   - validates the tag with a strict SemVer regex before any network call;
   - distinguishes "no stable release yet (latest prerelease: X)", "rate-limited" and "network failure";
   - repairs a damaged version directory through a manifest-hash check, or `NEXUS_FORCE=1`;
   - prints no curl progress meter.
6. **REQ-DX-101.** Doctor's stderr is empty on a healthy run, and its remedies are valid for the install type: packaged installs say "re-run the installer" or "add ~/.local/bin to PATH", never `make` or `harness.sh`.
7. **REQ-DX-102.** Doctor flags a group- or world-readable `~/.config/nexus/config.env` and offers a confirmed chmod 600. The repair is narrow, backed up and idempotent, like the existing three repairs.
8. **REQ-DX-103.** Doctor redaction never replaces filesystem paths wholesale. It redacts only credential-shaped substrings.
9. **REQ-DX-104.** `tui.launch` replaces `tui.build`. It reports PASS only if the installed launcher can start the TUI, by running `nexus-tui --live --check` (a new flag that resolves the sidecar and exits 0).
10. **REQ-REL-106 (POST-V1, docs RELEASE-REQUIRED).** `nexus self uninstall` / `nexus self prune`. For v1 the manual uninstall in quickstart remains the documented path.

## 3. Design

### 3.1 Unified launcher

Move routing into node, so that there is one grammar:

- **Commander default action** (`cli/src/index.ts:745-757`). With no args, if `process.stdin.isTTY && process.stdout.isTTY` and `nexus-tui` resolves (`NEXUS_HOME/lib/core/nexus-tui`, or `<repo>/core/target/release/nexus-tui`), `execFileSync`/`spawn` it with `--live --sidecar <resolved> --node process.execPath -- <args>` and `stdio: inherit`, and exit with its code. Otherwise fall back to the REPL with a one-line notice.
- **Top-level `--repl`, `--live`, `-r/--resume [id]`, `--approve`.** Declared as global options that map onto the default action, so the USER_MANUAL commands work (DEC-02).
- **`harness.sh`.** Reduced to `exec node "$SCRIPT_DIR/cli/dist/index.js" "$@"` with `NEXUS_HOME` unset (checkout mode). This removes REL-03 by construction.
- **`nexus-tui` sidecar resolution** (`live.rs:126-131`). Order: the `--sidecar` flag, then `$NEXUS_HOME/lib/cli/dist/sidecar.js`, then the checkout layout. The error message lists every path it tried.
- **`program.name("nexus")`.**

### 3.2 Version single source

- `package.json` is the source of truth. `scripts/sync-version.mjs` writes cli/package.json and Cargo.toml (`version = "x.y.z-pre"` is valid in Cargo). `cargo` then picks it up through `CARGO_PKG_VERSION`.
- `release.yml` fails if the four values differ from the tag.
- harness-core reports its version in an RPC `hello`. The bridge compares the reported version and protocol number and gives one actionable error on mismatch (this also serves SPEC-02's protocol bump).
- Stale local tags `v1.1.0`, `v1.2.0` and `v1.2.1` were deleted by the owner on 2026-10-14 (DEC-08, X1 done). They never existed on origin.

### 3.3 Doctor

| File and lines | Change |
|---|---|
| `doctor.ts:751,757` | Remove the abort listeners in `finally`. |
| `doctor.ts:332,492,316,520` | Branch remedies on `PACKAGED_HOME`. |
| `doctor.ts:103-110` | Exempt values that are absolute paths from entropy redaction (`redactDiagnostic(path, { kind: "path" })`). |
| (new) | Add the `config.env` permission check and repair, reusing `safe_fs.chmodVerified`. |
| (new) | Add `tui.launch`. |

### 3.4 Installer

- Validate the tag with `grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'`.
- Use `curl -fsSL --show-error`.
- On 404 from `/releases/latest`, query `/releases?per_page=1` and print: `no stable release yet; latest prerelease is vX — rerun with NEXUS_VERSION=vX`.
- A 403 with `x-ratelimit-remaining: 0` gives a rate-limit message.
- Write a `MANIFEST.sha256` of the extracted tree into each version directory. On reinstall, verify it and re-extract when it does not match.

## 4. Compatibility

- The packaged `nexus` with no arguments changes from the REPL to the TUI. That is the intended behaviour, but scripts that piped into the no-arg REPL will still get the REPL, because no TTY selects it.
- Removing the free-text default from `harness.sh` changes the developer workflow: `nexus fix the bug` becomes `nexus run "fix the bug"`. Alternatively, keep free text but only when the first word is not a valid identifier-like command name. Recommended: explicit `run`. Release notes must say so.

## 5. Acceptance criteria

| ID | Check |
|---|---|
| ACC-PKG-01 | Package smoke in a PTY: an installed `nexus` with no args renders the TUI header and idle hint. `nexus repl` gives the REPL prompt. `</dev/null nexus` gives the REPL. |
| ACC-PKG-02 | The doc-command extraction test passes against the package. Every fenced `nexus …` line is executed with `--help` appended, or in a no-op form, with no "unknown option/command". |
| ACC-PKG-03 | The release workflow fails on a version mismatch (negative test with a doctored Cargo.toml in CI). A fresh install's `doctor --json` has no `engine.binary` warning. |
| ACC-PKG-04 | `harness.sh notacmd` exits non-zero with "unknown command". `harness.sh trust .` runs trust. |
| ACC-PKG-05 | Installer: bad tag `v1.2.3/../x` is rejected before network. No-version with only prereleases prints the latest-prerelease hint. Deleting a dist file then reinstalling repairs it. |
| ACC-PKG-06 | `nexus doctor 2>err; test ! -s err` on a healthy fixture install. |
| ACC-PKG-07 | Packaged doctor remedies contain no `make` or `harness.sh` (grep over JSON). |
| ACC-PKG-08 | `config.env` at 0644 gives a warning and a proposed repair. `--fix --yes` sets 0600. A re-run reports no repair needed. |
| ACC-PKG-09 | A workspace path with a UUID segment appears unredacted in doctor output. The secret probes still show 0 leaks. |

## 6. Dependencies

- DEC-02, DEC-08 and DEC-14 (all resolved). Owner action X1 deletes the stale tags.
- SPEC-02's protocol version check shares the `hello` RPC.
