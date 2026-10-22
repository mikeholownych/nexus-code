# PLAN-07: Supply chain, compliance and release engineering

This plan implements [SPEC-07](../specs/SPEC-07-supply-chain-and-release-engineering.md). It belongs to milestone **M2**.

- Requirements: REQ-REL-107 to REQ-REL-114.
- Decisions: DEC-09, DEC-10.

## Safe change boundary

- `scripts/package-linux.sh`, `scripts/generate_sbom.sh`, `scripts/security_gates.sh`, `scripts/audit_rust_deps.py`
- `cli/test/security_gates.test.ts` (required by ACC-SUP-04; scanner behavior must remain fail-closed)
- `.github/workflows/{ci,release}.yml`, `.gitlab-ci.yml`
- `Makefile`
- new `about.toml`, `about.hbs`, `deny.toml`, `rust-toolchain.toml`
- `core/Cargo.toml` (`rust-version`)
- `cli/package.json` (`engines`)
- `.gitignore`, `cli/dist` (untrack)
- new `SECURITY.md`, `CHANGELOG.md`
- `docs/releases/`

## Tasks

| # | Task | Code locations | Depends on |
|---|---|---|---|
| 1 | Add `rust-toolchain.toml` pinned to the current stable (1.95.0 at audit time), set `rust-version` in Cargo.toml, and add `"engines": {"node": ">=22"}` (DEC-12). | root, `core/Cargo.toml`, `cli/package.json` | — |
| 2 | Third-party notices: install cargo-about and the npm license checker in CI. Use `about.toml` with an allowlist (MIT, Apache-2.0, BSD-2/3, ISC, Unicode-3.0, Zlib, MPL-2.0 only if reviewed). Have `package-linux.sh` write `THIRD_PARTY_NOTICES.txt` and upload it as an asset. | `package-linux.sh:22`; `release.yml` | 1 |
| 3 | `cargo deny check licenses advisories` in CI. Make `security_gates.sh` fail if `cargo-audit`/`cargo-deny` is missing, and delete `audit_rust_deps.py`. | `security_gates.sh:84-97`; `ci.yml`; `release.yml` | 1 |
| 4 | Build the SBOM from lockfiles with cyclonedx-npm and cargo-cyclonedx, merge and validate, and attach it to the release. Replace `generate_sbom.sh` and update `make sbom`. | `scripts/generate_sbom.sh`; `Makefile`; `release.yml` | — |
| 5 | Add provenance with `actions/attest-build-provenance` on the tarball and SHA256SUMS, and upload `install.sh` as a release asset. The installer optionally runs `gh attestation verify` when `gh` is available. | `release.yml:44-48`; `install.sh` | — |
| 6 | Add a CI matrix for Node 20/22/24 (tests). Packaging stays on Node 20. Pin the cargo-audit version. | `ci.yml` | 1 |
| 7 | Untrack `cli/dist`: `git rm -r --cached cli/dist`, add it to `.gitignore`, and check that the docs and `make build` cover it. Confirm `harness.sh` still errors helpfully when dist is missing. | `.gitignore`; `harness.sh`; docs | — |
| 8 | Delete `.gitlab-ci.yml`. Remove tracked `*.pyc` and ignore them. Point `make verify-reproducibility` at `package-linux.sh` run twice with mktemp and cmp. | `.gitlab-ci.yml`; `experiments/context-validation-2026-10-04/harness/__pycache__`; `Makefile:36-45` | — |
| 9 | Write `SECURITY.md` (private reporting via GitHub Security Advisories, supported versions, 7-day acknowledgement target) and `CHANGELOG.md` (back-filled from docs/releases). Set the release body from `docs/releases/<tag>.md` (`body_path`), and fail if that file is missing. | root; `release.yml` | — |
| 10 | Cross-runner reproducibility: a workflow_dispatch job builds on ubuntu-22.04 and ubuntu-24.04 with the pinned toolchain and compares the outputs. Run it once for the RC. | new `.github/workflows/repro.yml` | 1 |

## PR slices

| PR | Tasks |
|---|---|
| PR-7a | 1, 6, 8 |
| PR-7b | 2, 3 (notices and gates) |
| PR-7c | 4, 5 (SBOM and provenance) |
| PR-7d | 7 (dist untrack, isolated because the diff is large) |
| PR-7e | 9, 10 |

## Tests

- **ACC-SUP-01.** Add `scripts/check_notices.mjs`. It takes `cargo metadata --locked --format-version 1` (filtered to the dependency closure of the `harness-core` and `nexus-tui` targets) plus `npm ls --omit=dev --all --json`, and checks that every listed package appears in the notices file.
- **ACC-SUP-02.** Run `cyclonedx validate` in release.
- **ACC-SUP-03.** Run `gh attestation verify` in a post-release verification job against the published asset.
- **ACC-SUP-04.** Add a negative test to `security_gates.test.ts`: with `PATH` stripped of cargo-audit, the gate exits non-zero.
- **ACC-SUP-05 to ACC-SUP-08.** These are observed in CI or the repo state.

## Rollback

Workflow changes revert per PR. Untracking dist is reversible with `git add -f`.

## Definition of done

- ACC-SUP-01 to ACC-SUP-08 pass for the RC.
- The release assets are: tarball, SHA256SUMS, THIRD_PARTY_NOTICES.txt, the SBOM, install.sh, and the attestation.
