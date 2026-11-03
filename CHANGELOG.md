# Changelog

All notable changes to Nexus Code are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Detailed per-release documentation is maintained in [`docs/releases/`](docs/releases/).

## [v1.1.2] - 2026-11-01

See [`docs/releases/v1.1.2.md`](docs/releases/v1.1.2.md) (and candidate notes [`docs/releases/v1.1.2-rc.1.md`](docs/releases/v1.1.2-rc.1.md)) for full release notes.
Patch release: a crash-resumed work unit no longer receives the second and later messages of a multi-message prompt twice. The v1.1.1 notes carry a matching addendum.

## [v1.1.1] - 2026-11-01

See [`docs/releases/v1.1.1.md`](docs/releases/v1.1.1.md) (and candidate notes [`docs/releases/v1.1.1-rc.1.md`](docs/releases/v1.1.1-rc.1.md)) for full release notes.
Promoted release line delivering multi-agent orchestration, serialized git integration, typed inter-agent channels, operation replay, context-budget provenance, cancellation idempotency, durability-positive message acknowledgment, structured prompt provenance, and protected replay envelope error propagation.

## [v1.1.0] - 2026-10-31

See [`docs/releases/v1.1.0.md`](docs/releases/v1.1.0.md) (and candidate notes [`docs/releases/v1.1.0-rc.1.md`](docs/releases/v1.1.0-rc.1.md)) for full release notes. Scope and acceptance:
[`docs/v1.1.0/SPEC.md`](docs/v1.1.0/SPEC.md), [`docs/v1.1.0/REQUIREMENTS.md`](docs/v1.1.0/REQUIREMENTS.md).

### Added
- **Deterministic parallel work units:** `policy.maxConcurrentUnits` (default 1, bounded at 64) and
  `resources[].maxConcurrentUnits` (default 1). The scheduler returns an ordered due-set — required units first, then
  the longest unfinished dependent chain, then declaration order — and reserves per-resource slots. A unit whose
  qualified slots are busy stays runnable instead of being parked or blocked.
- **Serialised git integration queue:** concurrent isolated units merge one at a time into the operation branch, with
  `INTEGRATION_QUEUED` / `INTEGRATION_SKIPPED` events and receipts that now name the candidate digest, the executed
  tests and the 1-based merge sequence.
- **Typed inter-agent channel:** `request`, `observation`, `artifact` and `verdict` messages persisted in the operation
  record, delivered at most once to a unit or the whole operation; completed units publish their verified summary, and
  `nexus operation message` lets the operator publish one.
- **Operation replay:** `nexus operation status --replay [--json]` renders the recorded timeline, oldest first, with
  contiguous step indices. The view document is now schema version 2.
- **Context-budget provenance:** a `CONTEXT_BUDGET` block names the binding bound, the estimate and its source
  (`operator-budget` or `agent-estimate`), and `unit.context` records the source.

### Changed
- **Operation document schema 2:** a v1.0.0 operation record migrates in memory, gains `schemaVersion: 2`, and is
  copied byte-for-byte to `<record>.pre-migration-v1` before its first v2 write. A record from a newer build is refused
  with a one-line error and is **not** quarantined.
- **Strict operation specs:** unknown top-level, unit, `requires`, `policy`, `git` and resource keys are rejected with
  exit 2 and a suggested key. `git.publish` is rejected explicitly instead of being silently ignored.
- **View schema 2:** the checked-in `operation-view.schema.json` version and its test validator now agree; the
  validator enforces `minimum`, `maximum`, `minItems`, `pattern` and `maxLength` as well as the structural keywords.

### Fixed
- **Terminal safety in the operation view:** `view.status` and `unit.status` are rendered through `safeTerminal`, so a
  tampered or corrupt record cannot emit control or OSC sequences through a status field.

### Deferred
- PR publication (`git.publish`), the TUI operation pane, in-view decision interaction, semantic retrieval over
  operation records, and a unit-authored message tool. Each has a dated rationale in
  [`docs/v1.1.0/DECISIONS.md`](docs/v1.1.0/DECISIONS.md).

## [v1.0.0] - 2026-10-31

See [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md) for full release notes.

### Added
- **Packaged Product Parity:** Packaged binary launches the live Ratatui terminal UI on interactive TTYs, while falling back cleanly to the REPL when standard input is redirected (`</dev/null`).
- **Third-Party Notices:** Automated third-party notice generation (`THIRD_PARTY_NOTICES.txt`) covering 100% of Rust crates and npm production dependencies with license texts (`about.toml`, `about.hbs`).
- **CycloneDX SBOM:** Merged CycloneDX 1.5 JSON Software Bill of Materials (`sbom.cdx.json`) derived directly from lockfiles and validated in CI.
- **Build Provenance:** Cryptographic build provenance attestations via GitHub Actions artifact attestations (`actions/attest-build-provenance`). The installer supports optional verification using `gh attestation verify`.
- **Security Policy:** Private vulnerability intake and disclosure policy defined in [`SECURITY.md`](SECURITY.md).
- **Toolchain Pinning:** Rust toolchain pinned to 1.95.0 (`rust-toolchain.toml`, `rust-version = "1.85.0"`), Node.js pinned to `>=22`.
- **CI Test Matrix:** Multi-version Node testing across Node 22 and 24.
- **Reproducible Builds:** Byte-identical package generation across clean builds (`make verify-reproducibility`, `repro.yml`).

### Changed
- **Launcher Syntax:** Unknown commands fail explicitly; arbitrary execution requires explicit `nexus run "<task>"`.
- **Distribution Hygiene:** Untracked built TypeScript artifacts (`cli/dist`) from version control. `harness.sh` warns helpfully if `cli/dist` is not yet built.
- **Security Gates:** Security gate script (`security_gates.sh`) hardened to fail closed if neither `cargo-deny` nor `cargo-audit` is installed; removed toy fallback.

### Fixed
- **Upgrade Power-Loss Durability:** The extracted release package is fsynced before it is renamed into place and the launcher is switched. Previously a rename persisted only the directory entry, so a power loss shortly after an upgrade could leave the live launcher pointing at zero-length binaries, making `nexus upgrade --recover` itself unavailable.

## [v0.1.0-alpha.2] - 2026-10-14

See [`docs/releases/v0.1.0-alpha.2.md`](docs/releases/v0.1.0-alpha.2.md) for full release notes.

### Added
- **Durable Compaction:** State compactions are committed in sequence with fsync; compaction errors fail closed as `PERSISTENCE_FAILED`.
- **Provider Discovery:** Context size and output allowance dynamically discovered from provider `/models` endpoints.
- **Token Accounting:** Exact request token counting via `/v1/tokenize` when advertised by gateway.

### Changed
- **Long Tasks & Compaction:** Removed arbitrary 300-step / 120-minute defaults; turn continues across durable segment checkpoints while making progress.
- **Loop & Repetition Detection:** State-aware action repetition checks against workspace snapshot diffs.
- **Length Recovery:** Clean handling of truncated model replies (`finish_reason=length`) without aborting on first occurrence.

## [v0.1.0-alpha.1] - 2026-10-13

See [`docs/releases/v0.1.0-alpha.1.md`](docs/releases/v0.1.0-alpha.1.md) for full release notes.

### Added
- **Initial Alpha:** Initial package release for Linux x86-64 with glibc 2.35+.
- **Components:** Combined TypeScript CLI/sidecar, Rust `harness-core` workspace tools, and Ratatui `nexus-tui`.
- **Installer:** Self-contained one-line shell installer (`install.sh`) with SHA-256 integrity validation.
