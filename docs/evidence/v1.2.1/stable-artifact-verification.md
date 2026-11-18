# v1.2.1 stable artifact verification (before publication)

The `v1.2.1` tag (`b0d59908`, a version-only commit directly on `v1.2.1-rc.2`, checked by `scripts/check-version-only-diff.mjs`) built a draft release. It was published on 2026-11-18 05:32Z after these checks on the draft:

- Release workflow run 44240638181: completed/success (CLI suite, security gates, two reproducible package builds compared byte for byte, SBOM validation, package smoke, installer smoke, provenance attestation).
- `nexus-linux-x86_64-v1.2.1.tar.gz` sha256 `18d2f2485d4c11e01d126447967f0967a1497484bcdeb6aaead299aefac5480a` matched `SHA256SUMS`; `gh attestation verify` passed for the archive and for `SHA256SUMS`.
- Package contents compared with the accepted rc.2 archive: the same 400 files. Ten differ: `MANIFEST.sha256`, `THIRD_PARTY_NOTICES.txt` (version string only), `VERSION`, `compatibility.json`, `lib/cli/dist/build-info.json` (commit and time), `lib/cli/package.json`, `lib/cli/package-lock.json`, `lib/cli/node_modules/.package-lock.json`, and the two Rust binaries (`harness-core`, `nexus-tui`), which are rebuilt with the new crate version and therefore differ in symbol hashes and layout. Everything under `lib/cli/dist` other than `build-info.json` is byte-identical, i.e. the TypeScript client the G1.1-4 matrix measured is the same code.
- A public install of the published release into a throwaway `HOME` with `NEXUS_VERIFY_ATTESTATION=1` verified provenance and printed `1.2.1 (b0d59908e75a)`.

Not done: the live tool-call matrix was not repeated on the stable archive (see `G1.1-4-rc.2.md`), and the rebuilt Rust binaries were not separately qualified beyond the workflow's package and installer smoke tests.
