# v1.3.0 stable artifact verification (before publication)

The `v1.3.0` tag (`5ac7d0e46`, a version-only commit directly on `v1.3.0-rc.1`, checked by `scripts/check-version-only-diff.mjs`) built a draft release. It was published on 2026-11-25 19:53Z after these checks on the draft:

- Release workflow run 45684597020: completed/success (CLI suite, security gates, two reproducible package builds compared byte for byte, SBOM validation, package smoke, installer smoke, provenance attestation).
- `nexus-linux-x86_64-v1.3.0.tar.gz` sha256 `827873b022f96d24d595ee45278192d99a07efdec410204c14f255503f005974` matched `SHA256SUMS`; `gh attestation verify` passed for the archive.
- Package contents compared with the accepted rc.1 archive: the same 672 files. Ten differ: `MANIFEST.sha256`, `THIRD_PARTY_NOTICES.txt` (version string), `VERSION`, `compatibility.json` (version, revision, build time), `lib/cli/dist/build-info.json` (commit and time), `lib/cli/package.json`, `lib/cli/package-lock.json`, `lib/cli/node_modules/.package-lock.json`, and the two Rust binaries (`harness-core`, `nexus-tui`), which are rebuilt with the new crate version. Everything under `lib/cli/dist` other than `build-info.json` is byte-identical, i.e. the TypeScript client that was measured on rc.1 is the one shipped.
- The tag is annotated and signed; GitHub reports it verified. Parent of the version-only commit is `v1.3.0-rc.1` (`e65439de1`).

Not done: no live tool-call matrix (G1.1-4) was run for this candidate, and the rebuilt Rust binaries were not separately qualified beyond the workflow's package and installer smoke tests. External qualification remains pending.
