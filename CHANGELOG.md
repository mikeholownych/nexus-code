# Changelog

All notable changes to Nexus Code are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Detailed per-release documentation is maintained in [`docs/releases/`](docs/releases/).

## [v1.0.0] - Unreleased (Release Candidate)

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
