# RC9 artifact integrity and isolated installation record

**Observed:** 2026-10-26 18:00 UTC  
**Release:** `v1.0.0-rc.9`  
**Source commit:** `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566`  
**Disposition:** Artifact integrity and installation smoke evidence only. This is not exact-RC product qualification or acceptance.

## Published source and release

- The annotated tag object is `d211d1c7545d2dd629531e4f712e98a240a782c6`, targeting the source commit above.
- Local `git verify-tag v1.0.0-rc.9` returned a good signature from `Mike Holownych <mike.holownych@aisyndicate.io>`.
- GitHub's commit API reports the source commit verification as `verified: true`, `reason: valid`.
- GitHub's tag-object API separately reports `verified: false`, `reason: bad_email`. The local signature result does not change or override GitHub's tag-object status.
- Release workflow [40370485753](https://github.com/mikeholownych/nexus-code/actions/runs/40370485753) completed successfully. The prerelease was published at 2026-10-26 17:56:16 UTC.
- Published Linux x86-64 archive: `nexus-linux-x86_64-v1.0.0-rc.9.tar.gz`, 4,859,736 bytes, SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`.
- Published `SHA256SUMS` asset SHA-256: `70a80c9afb658c40506534e8fd80eb5e7b4cdd28431aa7fd0e285f136513ce77`.
- Downloading all listed release assets and running `sha256sum -c SHA256SUMS` succeeded for the archive and `compatibility.json`.
- `gh attestation verify` exited 0 for both the archive and `SHA256SUMS`, against repository `mikeholownych/nexus-code`. The verified archive attestation subject digest matches the published archive digest above.

## Isolated desktop installation

The official `install.sh` asset was run on the connected Ubuntu/GNOME desktop with:

```sh
NEXUS_VERSION=v1.0.0-rc.9 \
NEXUS_PREFIX="$HOME/.local/nexus-rc9-qualification" \
NEXUS_VERIFY_ATTESTATION=1 sh install.sh
```

The installer reported successful provenance verification for the archive and checksum index, installed into the new isolated prefix, and its pre-install binary self-test passed. The existing default Nexus installation and its RC6/RC8 version directories were not changed.

The installed `--version` output was `1.0.0-rc.9 (4cae11cbc3b0)`. Its `.provenance.json` records source revision `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566` and archive SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`. The installed `MANIFEST.sha256` file's SHA-256 is `4cf1b288892891c3db6135c8bb9919e4a21e871ef2c5be5c211e39fa13bde0e6`.

## Limits of this record

This records artifact identity, published checksums, provenance verification results, and an installed-package version/self-test. It does not establish provider behavior, upgrade behavior from RC6, held-out results, standalone engineering correctness, T3/T4 results, cross-runner reproducibility, the manual terminal matrix, or independent RC acceptance. Acceptance remains `IN_PROGRESS`.
