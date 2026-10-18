# SPEC-12: CLI and TUI upgrade commands

| | |
|---|---|
| Status | Ready. Scope addition authorized by owner/user before RC freeze. |
| Release class | **BLOCKER**: in-product safe upgrade mechanism for CLI and TUI; required before RC freeze. |
| Requirements | REQ-REL-115 |
| Findings | UPG-01 (no supported in-product upgrade path without manual curl-pipe script execution) |
| Plan | [PLAN-12](../plans/PLAN-12-cli-and-tui-upgrade.md) |
| Acceptance | ACC-UPG-01 to ACC-UPG-06 |

## 1. Problem

Nexus currently requires operators to re-run the external `install.sh` script via `curl -fsSL ... | sh` to upgrade or downgrade installed binaries. There is no CLI command (`nexus upgrade`) and no TUI slash command (`/upgrade`) to:
1. Discover whether a new stable release is published on the canonical distribution repository.
2. Compare the currently installed product version against published releases using semantic versioning.
3. Inspect upgrade, downgrade, or reinstallation changes non-destructively (`--check`).
4. Perform an atomic, verified, checksummed upgrade directly from the terminal or TUI with deliberate operator confirmation.
5. Prevent destructive operations on source/development checkouts or unsupported installations while guiding the user to the correct update procedure.
6. Safeguard active TUI sessions so running components are not swapped out mid-operation.

## 2. Requirements

1. **REQ-REL-115 (CLI and TUI upgrade).**
   - Provide `nexus upgrade` and `/upgrade` slash command backed by a shared release-resolution and upgrade engine.
   - Support `nexus upgrade --check` and `nexus upgrade --check --version <v>` to non-destructively compare installed and published versions, exiting 0 (up to date), 1 (update available), or 2 (operational error).
   - Support `nexus upgrade` (defaulting to latest published stable release, excluding drafts and prereleases) and `nexus upgrade --version <version>` (targeting exact pinned release, allowing prereleases only when explicitly requested).
   - Support structured JSON output via `--json` across check and upgrade operations.
   - Strictly compare versions using Semantic Versioning 2.0.0 rules (not lexical ordering), normalizing `v` prefixes consistently, and distinguishing release channels (stable vs prerelease).
   - Require explicit confirmation for downgrades, both interactively and noninteractively (`--allow-downgrade`).
   - Require deliberate confirmation before modifying installations. In noninteractive CLI execution, require the repository's established `--yes` confirmation flag and refuse indefinite prompting.
   - In the TUI, `/upgrade` must use the established deliberate approval interaction (`Overlay::Approval`), ensuring ordinary typing, queued input, pasted input, or accidental bare Enter cannot authorize an installation change.
   - Detect installation provenance: distinguish packaged installations (`$PREFIX/lib/nexus/$VERSION` with symlink `$PREFIX/bin/nexus`) from development checkouts (`git` / source tree). For development checkouts or unsupported installations, refuse destructive overwrite and report the supported update procedure (`git pull && make build`).
   - Reuse canonical installation layout and verification: download release archive `nexus-linux-x86_64-$VERSION.tar.gz` and `SHA256SUMS`, verify SHA-256 integrity, verify package manifest and runtime binaries (`bin/nexus`, `lib/core/harness-core`, `lib/core/nexus-tui`, `VERSION`), and execute an atomic symlink swap (`ln -s ... .nexus-link.$$; mv -f .nexus-link.$$ $PREFIX/bin/nexus`).
   - Prevent concurrent upgrade attempts via atomic lockfile.
   - Preserve configuration, credentials, history, and sessions in `~/.nexus`.
   - Protect running TUI processes: never terminate active sessions unsafely or overwrite loaded components; report when restart is required and verify the upgraded version upon fresh launch without claiming the current process has changed version in-flight.
   - Do not add unsolicited background network polling, telemetry, or auto-update daemons.

## 3. Design

### 3.1 Architecture

The upgrade capability is implemented in `cli/src/upgrade.ts` as a pure, testable engine with interfaces for release lookup, provenance detection, artifact retrieval, integrity verification, and atomic switching.

```
                      ┌───────────────────────────┐
                      │  CLI: nexus upgrade [...]  │
                      └─────────────┬─────────────┘
                                    │
                                    ▼
┌─────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ TUI: /upgrade [...]     ├──►│    Upgrade Engine         ├──►│ GitHub Releases API       │
│ (deliberate approval)   │   │    (cli/src/upgrade.ts)   │   │ & SHA256SUMS asset        │
└─────────────────────────┘   └─────────────┬─────────────┘   └───────────────────────────┘
                                            │
                             ┌──────────────┴──────────────┐
                             ▼                             ▼
                 [Packaged Installation]          [Development Checkout]
                 Verify SHA256 & Manifest         Refuse overwrite;
                 Atomic symlink swap              Provide git pull & build advice
```

### 3.2 Semantic Versioning and Tag Resolution

- Format: `v<MAJOR>.<MINOR>.<PATCH>[-<PRERELEASE>]`.
- Precedence: SemVer 2.0.0. Major, minor, patch compare numerically. Prerelease tags have lower precedence than normal releases; dot-separated prerelease identifiers compare numerically if both numeric, else ASCII-lexicographically.
- Stable release resolution: Queries `/releases/latest` or searches `/releases` filtering out `draft == true` and `prerelease == true`.
- Exact version resolution: Queries `/releases/tags/<tag>` with normalized `v` prefix. Prereleases are allowed only if explicitly targeted.
- Downgrades: When `target < installed`, the upgrade engine flags the action as `downgrade` and requires explicit authorization (`--allow-downgrade` or explicit confirmation).

### 3.3 Installation Provenance and Safety

- **Packaged Installation**:
  - Identified by `NEXUS_HOME` environment variable or resolution of executable path relative to `$PREFIX/lib/nexus/$VERSION`.
  - Prefix `$PREFIX` defaults to `~/.local` (or `$NEXUS_PREFIX` / parent of `lib/nexus`).
  - Target directory is `$PREFIX/lib/nexus/$TARGET_VERSION`.
  - Atomic link creation: `ln -s "$PREFIX/lib/nexus/$TARGET_VERSION/bin/nexus" "$PREFIX/bin/.nexus-link.$PID"` followed by atomic `rename` (`mv -f`) to `$PREFIX/bin/nexus`.
  - Concurrency: Flocked or exclusive lockfile `$PREFIX/lib/nexus/.upgrade.lock`.
- **Development / Source Checkout**:
  - Identified by absence of `NEXUS_HOME` / packaged layout and presence of repo markers (`package.json`, `core/Cargo.toml`, `.git`).
  - Upgrade command reports: "Nexus is running from a development checkout. Use `git pull && make build` to update."
- **Integrity**:
  - Downloads release tarball and `SHA256SUMS`.
  - Computes SHA-256 of downloaded archive; compares with published checksum.
  - If `gh` is installed and `NEXUS_VERIFY_ATTESTATION != 0`, verifies GitHub build provenance attestation.
  - Extracts to staging directory; validates `bin/nexus`, `lib/core/harness-core`, `lib/core/nexus-tui`, and `VERSION`.
  - Verifies package `MANIFEST.sha256` if present.

### 3.4 TUI Slash Command and Approval

- `/upgrade` routes through `cli/src/slash/router.ts` to `session_commands.ts`.
- Uses `host.confirm` / deliberate approval to request confirmation.
- Emits `approval.request` event to the TUI.
- TUI displays `Overlay::Approval` with review details:
  - Installed version and target version.
  - Action (upgrade, downgrade, reinstall).
  - Target destination directory.
  - Notice explaining that running session continues safely and restart is required.
- Requires operator review following deliberate approval invariants (quiet time, deliberate keypress, immunity to queued or pasted input).

## 4. Acceptance Criteria

| ID | Check | Pass condition |
|---|---|---|
| ACC-UPG-01 | `nexus upgrade --check` | Compares installed version with latest published stable release. Exits 0 if already current, 1 if update available, 2 on operational error. Does not modify filesystem. |
| ACC-UPG-02 | `nexus upgrade --check --version <v>` | Compares installed version with exact specified version. Exits 0 if matching/newer, 1 if update available, 2 on error/missing release. |
| ACC-UPG-03 | `nexus upgrade` (CLI install) | Resolves latest stable release; prompts for confirmation in interactive mode; requires `--yes` in noninteractive mode; exits with code 0 on success, 1 if declined, 2 on failure. |
| ACC-UPG-04 | Downgrade and pinned version safety | Reject downgrade unless explicitly confirmed or `--allow-downgrade` is provided. Rejects invalid tags and non-existent releases fail-closed. |
| ACC-UPG-05 | `/upgrade` slash command in TUI | Supports `--check`, `--version`, and install modes. Uses deliberate TUI approval modal (`Overlay::Approval`). Preserves session state and explains restart requirement. |
| ACC-UPG-06 | Installation provenance and recovery | Refuses destructive overwrite of development checkout with actionable message. Verifies SHA-256 checksums before switching. Atomic symlink swap leaves previous installation intact on error. |

## 5. Dependencies and Concurrency

- Conforms to `CONCURRENCY.md`: single PR slice `PLAN-12_PR-12a`.
- Hot file claims: `FILE_cli_src_index.ts`, `FILE_harness.sh`, `FILE_docs_USER_MANUAL.md`.
- No disruption of running qualification gates (DEC-05 / SPEC-10).
