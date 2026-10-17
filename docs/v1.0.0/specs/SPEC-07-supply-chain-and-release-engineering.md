# SPEC-07: Supply chain, compliance and release engineering

| | |
|---|---|
| Status | Ready. GitHub attestations for provenance (DEC-09); `cli/dist` untracked (DEC-10). |
| Release class | **BLOCKER**: third-party notices (license obligation for redistributed binaries). RELEASE-REQUIRED: SBOM, provenance, SECURITY.md, CHANGELOG, CI matrix, gate fail-closed, dist freshness. |
| Requirements | REQ-REL-107, REQ-REL-108, REQ-REL-109, REQ-REL-110, REQ-REL-111, REQ-REL-112, REQ-REL-113, REQ-REL-114 |
| Findings | REL-05, REL-06, REL-07, REL-09, REL-13, MNT-01, MNT-02, MNT-03, MNT-05, MNT-06, HIST-07, EVL-007 |
| Historical requirements | REL-001..004, SCAN-001..005 (Issue #12) |
| Plan | [PLAN-07](../plans/PLAN-07-supply-chain-and-release-engineering.md) |
| Acceptance | ACC-SUP-01 to ACC-SUP-08 |

## 1. Problem and evidence

| Finding | What is wrong | Evidence |
|---|---|---|
| REL-05 | The release archive contains only the project LICENSE. About 150 Rust crates (MIT/Apache-2.0 and others) are statically linked into `harness-core` and `nexus-tui`, with no attribution. No SBOM is published. | RUNTIME + SOURCE (`scripts/package-linux.sh:22`) |
| REL-06 | `scripts/generate_sbom.sh` lists direct dependencies only, with versions taken from ranges, not lockfiles. It is not run in release. | SOURCE |
| REL-07 | The fallback "RustSec database" in `scripts/audit_rust_deps.py` is 9 hard-coded advisories, yet it prints "clean". The real `cargo audit` runs in CI only because the runner image ships it. | SOURCE + CI log |
| REL-09 | There is no signature or provenance attestation, and the installer is served from mutable `main`. | SOURCE |
| REL-13 | CI covers Node 20 only (the developer runs 24.21.0) and a floating stable Rust. There is no `rust-toolchain.toml`, no MSRV, no `engines` field, and no check that `cli/dist` is fresh. | SOURCE + CI log |
| MNT-01 | `cli/dist` (86 generated files) is tracked. It matches a fresh build today, but nothing enforces that. | MEASUREMENT |
| MNT-02 | `.gitlab-ci.yml` is dead and divergent. | SOURCE |
| MNT-03 | `make verify-reproducibility` writes fixed `/tmp` paths and covers dist only. | SOURCE |
| MNT-05 | Release bodies are "Full Changelog" only, and there is no CHANGELOG.md. | RUNTIME |
| HIST-07 | There is no SECURITY.md vulnerability intake, yet the repository is public and releases are published, so REL-004's patch obligation is live. | SOURCE |
| EVL-007 | `__pycache__/*.pyc` files are tracked under `experiments/`. | SOURCE |

Strengths to preserve:

- The release is gated on main ancestry and a version match.
- The full suite runs, including PTY e2e tests.
- Two package builds are compared with `cmp`.
- Package and installer smoke tests run.
- `npm audit` is clean.
- Builds use `--locked` and `npm ci`.

## 2. Requirements

1. **REQ-REL-107.** Each release ships `THIRD_PARTY_NOTICES.txt` inside the archive and as a release asset. It covers 100% of the Cargo.lock packages compiled into the shipped binaries and all production npm packages, with license texts.
2. **REQ-REL-108.** Each release ships a lockfile-derived SBOM: CycloneDX 1.5 JSON for npm (prod) and Cargo, merged. It is validated by `cyclonedx validate` in CI.
3. **REQ-REL-109.** Release assets carry verifiable provenance (DEC-09: `actions/attest-build-provenance`). The installer can optionally verify it when `gh` is present. The installer is also published as a release asset, so a tag-pinned installer exists.
4. **REQ-REL-110.** The vulnerability gate fails closed. `cargo-audit` or `cargo-deny` is installed explicitly in workflows with `--locked`. The toy fallback is removed. A missing tool exits non-zero.
5. **REQ-REL-111.** The CI matrix covers Node 20, 22 and 24, with a pinned Rust toolchain (`rust-toolchain.toml`) and a declared MSRV (`rust-version`). It includes a `cli/dist` freshness check, with dist untracked per DEC-10. The package declares `"engines": { "node": ">=20" }`.
6. **REQ-REL-112.** SECURITY.md defines the reporting channel, the supported versions and the response targets. CHANGELOG.md is maintained, and the release body is taken from `docs/releases/<tag>.md` (the release fails if that file is missing).
7. **REQ-REL-113.** Dead CI config is removed, and tracked bytecode is removed and ignored.
8. **REQ-REL-114.** Cross-machine reproducibility is demonstrated once for the RC: two different runner images with the pinned toolchain produce identical tarballs. This is RELEASE-REQUIRED evidence, not a code change.

## 3. Design

- **Notices.**
  - Rust: `cargo about generate about.hbs > THIRD_PARTY_NOTICES-rust.txt`, with an `about.toml` license allowlist.
  - npm: `npx --yes license-checker-rseidelsohn --production --plainVertical` from `cli/`.
  - `package-linux.sh` concatenates both into the archive root.
  - `cargo deny check licenses` runs in CI with the same allowlist, so new incompatible licenses fail early.
- **SBOM.** `npx @cyclonedx/cyclonedx-npm --omit dev` and `cargo cyclonedx --format json`, merged with `cyclonedx merge`. Replace `scripts/generate_sbom.sh` and update `make sbom`.
- **Provenance.** Add `permissions: id-token: write, attestations: write` to release.yml and a step `actions/attest-build-provenance@v1` with `subject-path` set to the tarball and SHA256SUMS. Docs: `gh attestation verify <tarball> -R mikeholownych/nexus-code`.
- **CI.** `strategy.matrix.node: [20, 22, 24]` for the test job. Packaging runs on Node 20 only. Add `cargo install cargo-audit --locked --version <pin>`. Add a step `git diff --exit-code -- cli/dist` after the build.

## 4. Acceptance criteria

| ID | Check |
|---|---|
| ACC-SUP-01 | The RC archive contains `THIRD_PARTY_NOTICES.txt`. A script asserts that every `name version` in `cargo metadata --locked` for the shipped binaries and in `npm ls --omit=dev --all` appears in it. |
| ACC-SUP-02 | `cyclonedx validate --input-file sbom.cdx.json` passes. The component count equals the lockfile prod closure (±0). |
| ACC-SUP-03 | `gh attestation verify` passes for the RC tarball. |
| ACC-SUP-04 | `PATH` without cargo-audit makes `security_gates.sh` exit non-zero. |
| ACC-SUP-05 | The CI matrix is green on Node 20, 22 and 24, and the dist-freshness step is present. |
| ACC-SUP-06 | SECURITY.md and CHANGELOG.md exist. `gh release view <rc>` body equals `docs/releases/<rc>.md`. |
| ACC-SUP-07 | `.gitlab-ci.yml` is removed (or marked as a mirror). `git ls-files '*.pyc'` is empty. |
| ACC-SUP-08 | Cross-runner reproducibility: tarballs built on ubuntu-22.04 and ubuntu-24.04 runners with the pinned toolchain are byte-identical, or the differences are documented and accepted as a DEC-10 follow-up. |

## 5. Dependencies

- DEC-09 and DEC-10 (both resolved).
- SPEC-06's version sync runs first in the release job.
