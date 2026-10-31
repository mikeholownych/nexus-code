# RC15 cross-runner reproducibility evidence

**Disposition: PASS for REQ-REL-114 / ACC-SUP-08.** GitHub Actions workflow [41185904380](https://github.com/mikeholownych/nexus-code/actions/runs/41185904380) completed successfully on 2026-10-31. It resolved the published `v1.0.0-rc.15` tag to source commit `865e342d481d427c8ea7ecb0088fc5fda7e89f6f` and built on distinct GitHub-hosted Ubuntu 22.04 and Ubuntu 24.04 runners.

Both builds used Node `v22.22.1`, npm `10.9.4`, Rust/Cargo `1.95.0`, and the pinned `rust:1.95.0-bookworm` image digest recorded in each identity file. The source tree, lockfiles, package tool and exact RC identity matched. The workflow comparator passed byte comparisons between both runner outputs and the six selected public RC15 assets: `SHA256SUMS`, `THIRD_PARTY_NOTICES.txt`, `compatibility.json`, `install.sh`, the Linux x86_64 archive, and `sbom.cdx.json`.

The workflow evidence artifact records `REQ-REL-114 / ACC-SUP-08: PASS`. The workflow comparator is the retained evidence for the byte comparisons; no separate manual download-and-comparison record is included in this packet. The archive SHA-256 is `5dd7e83ade728f7ab88b6fe789a36e4205a19784ffb74f7c66356544842fc956`. The source/tag, toolchain, runner, and selected artifact identities are retained in `repro-evidence.json` and the runner identity files.

This passes the cross-runner reproducibility gate only. It does not establish installed-RC product qualification, held-out T2/T3/T4 acceptance, provider/standalone acceptance, independent RC acceptance, or stable-release readiness.

## Reproduction

1. Download workflow artifacts from run 41185904380 and public assets for `v1.0.0-rc.15`.
2. In each runner artifact directory, run `sha256sum --check SHA256SUMS`.
3. Compare the six files listed above between both runner artifacts and the public release assets.
4. Verify both runner identity files and `repro-evidence.json` bind to tag commit `865e342d481d427c8ea7ecb0088fc5fda7e89f6f` and run 41185904380.

The `SHA256SUMS` in this directory covers every retained evidence file except itself.
