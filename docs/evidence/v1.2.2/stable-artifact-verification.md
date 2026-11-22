# v1.2.2 stable artifact verification (before publication)

The `v1.2.2` tag (`ce2c951e`, a version-only commit directly on `v1.2.2-rc.1`, checked by `scripts/check-version-only-diff.mjs`) built a draft release. It was published on 2026-11-21 23:59Z after these checks on the draft:

- Release workflow run 44961758674: completed/success (CLI suite, security gates, two reproducible package builds compared byte for byte, SBOM validation, package smoke, installer smoke, provenance attestation).
- `nexus-linux-x86_64-v1.2.2.tar.gz` sha256 `aac29f264d004bbb61b39559c5b617c72fcfde88f4873b9608a852703f9c00dc` matched `SHA256SUMS`; `gh attestation verify` passed for the archive and for `SHA256SUMS`.
- Package contents compared with the accepted rc.1 archive (sha256 `57bdf05a…`): the same 420 files. Ten differ: `MANIFEST.sha256`, `THIRD_PARTY_NOTICES.txt` (version string only), `VERSION`, `compatibility.json` (version, revision, build time), `lib/cli/dist/build-info.json` (commit and time), `lib/cli/package.json`, `lib/cli/package-lock.json`, `lib/cli/node_modules/.package-lock.json`, and the two Rust binaries (`harness-core`, `nexus-tui`), which are rebuilt with the new crate version. Everything under `lib/cli/dist` other than `build-info.json` is byte-identical, i.e. the TypeScript client that was measured on rc.1 is the one shipped.
- A public install of the published release into a throwaway `HOME` with `NEXUS_VERIFY_ATTESTATION=1` verified provenance and printed `1.2.2 (ce2c951e249d)`. The published `install.sh` is byte-identical to the copy verified on the draft.
- The tag is signed and GitHub reports it verified.

Not done: the live tool-call matrix was not repeated on the stable archive (see `G1.1-4-rc.1.md`), and the rebuilt Rust binaries were not separately qualified beyond the workflow's package and installer smoke tests.
