# Nexus v1.0.0-rc.14 artifact verification

This record binds to the published, signed `v1.0.0-rc.14` tag at source commit `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99` and release workflow run [41035120551](https://github.com/mikeholownych/nexus-code/actions/runs/41035120551). It establishes artifact integrity and a clean install; it does **not** establish product qualification, RC acceptance, or stable-release readiness.

## Verified results

- The release workflow and exact-source CI/CodeQL runs completed successfully. The workflow's Node 22/24 and Linux test/build/security gates passed. Its release job performed two package builds and byte-compared the archive, checksum index, notices, SBOM, and installer; SBOM validation, package smoke, installer smoke, provenance attestation, and release upload all passed.
- All nine published release assets were downloaded. Their sizes and SHA-256 digests match GitHub's asset API; `SHA256SUMS` validates the RC archive and compatibility metadata. The archive digest is `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`.
- The archive contains the expected CLI, sidecar/runtime dependencies, `harness-core`, `nexus-tui`, compatibility metadata, package manifest, and third-party notices. The dependency notice checker independently found 119 Rust crates and 21 production npm packages.
- The SBOM is CycloneDX 1.5 and passes release-workflow validation. It contains 142 components: 119 Cargo production dependencies plus the Cargo root, and 21 npm production dependencies plus the CLI root, matching the exact source lockfiles.
- `gh attestation verify` independently passed for the archive and `SHA256SUMS`, constrained to repository `mikeholownych/nexus-code` and signer `.github/workflows/release.yml`. Verified provenance identifies the RC14 tag and source commit above.
- The workflow-produced release installer was run with `NEXUS_VERIFY_ATTESTATION=1` in a disposable HOME. It verified provenance and installed RC14. `nexus --version`, `nexus --help`, the installed package manifest, symlink target, and version file all passed. The installed CLI reported `1.0.0-rc.14 (16eeb6eeffe7)`.
- The GitHub release body matches `docs/releases/v1.0.0-rc.14.md` in substantive content. The GitHub API representation contains one additional terminal LF; the byte comparison after terminal-LF normalization passes.

## Gate status

| Gate | Status | Evidence |
|---|---|---|
| ACC-SUP-01 | PASS | Release package smoke and `notices-check.log` |
| ACC-SUP-02 | PASS | Workflow SBOM generation/count check and `sbom-counts.json` |
| ACC-SUP-03 | PASS | `archive-attestation.json`, `checksums-attestation.json` |
| ACC-SUP-06 | PASS | `release-body-comparison.txt` |
| ACC-SUP-08 | IN PROGRESS | Exact-RC two-runner workflow [41038503854](https://github.com/mikeholownych/nexus-code/actions/runs/41038503854); not yet counted as a pass |
| Clean installed-RC entrypoint check | PASS | `installer-run.log` |

The installed-RC product qualification matrix remains in progress. Held-out T2/T3/T4 qualification has not started; it still requires independent custodian acceptance. Provider, standalone, lifecycle, fault-injection, installed-RC PTY, and independent acceptance gates remain outstanding. The manual five-terminal by three-size matrix is waived for v1.0.0 by DEC-20; automated CI PTY and scripted installed-RC PTY remain mandatory.

## Reproduction

1. Download all assets from the release URL in `manifest.json`.
2. Compare each downloaded file's SHA-256 and size to `release-assets.json`.
3. Run `sha256sum --check SHA256SUMS` in the asset directory.
4. Verify the archive and checksum attestations with `gh attestation verify` using the exact signer and repository recorded above.
5. Follow the captured isolated-HOME install invocation in `installer-run.log` with the published RC installer and `NEXUS_VERIFY_ATTESTATION=1`.

`SHA256SUMS` in this directory covers every retained evidence file except `SHA256SUMS` itself. It does not cover the public release archive; that archive is identified by its public release digest above.
