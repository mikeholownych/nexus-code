# RC14 cross-runner reproducibility evidence

**Disposition: PASS for REQ-REL-114 / ACC-SUP-08.** GitHub Actions workflow [41038503854](https://github.com/mikeholownych/nexus-code/actions/runs/41038503854) completed successfully on 2026-10-30. The workflow resolved the signed `v1.0.0-rc.14` tag to source commit `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99` and built on distinct GitHub-hosted Ubuntu 22.04 and Ubuntu 24.04 runners.

Both runs used Node `v22.22.1`, npm `10.9.4`, Rust/Cargo `1.95.0`, and the pinned `rust:1.95.0-bookworm` image digest recorded in each identity file. They recorded matching source tree, lockfiles, packaging script, and exact candidate identity. The compare job passed byte comparisons for the two runner outputs and the six selected published release assets: `SHA256SUMS`, `THIRD_PARTY_NOTICES.txt`, `compatibility.json`, `install.sh`, the Linux x86_64 archive, and `sbom.cdx.json`.

The downloaded workflow outputs were independently checked here: both runner `SHA256SUMS` files passed, and each of the six files compared byte-for-byte with the downloaded public RC14 asset. The archive SHA-256 is `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`. The exact source and signed tag identity are retained in `repro-evidence.json`; runner labels, images, versions, and toolchains are retained separately.

This passes the cross-runner reproducibility gate only. It does not establish installed-RC product qualification, held-out T2/T3/T4 acceptance, provider/standalone acceptance, or independent RC acceptance.

## Reproduction

1. Download the workflow artifacts from run 41038503854.
2. Check each runner output with `sha256sum --check SHA256SUMS`.
3. Compare the six files listed above against the public assets for `v1.0.0-rc.14`.
4. Verify that each runner identity and the workflow summary bind to source commit `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99` and run 41038503854.

The `SHA256SUMS` in this directory covers all retained evidence files except itself.
