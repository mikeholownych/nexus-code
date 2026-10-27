# REQ-REL-114 / ACC-SUP-08: cross-runner reproducibility on `v1.0.0-rc.10`

| | |
|---|---|
| Requirement | `REQ-REL-114` (ACC-SUP-08) |
| Result | **PASS** |
| Tag | `v1.0.0-rc.10` |
| Tag commit | `16ee8ca3643824741b6da67936b41f262414fdf0` |
| Tree | `4e76eadcb44f419001f67960241517000a8b682a` |
| Workflow run | [40564959805](https://github.com/mikeholownych/nexus-code/actions/runs/40564959805) (`refs/heads/main`, `cf05322cc0368af900b2fb425852daa2d0de403e`, attempt 1) |
| Jobs | `resolve-tag`, `build (ubuntu-22.04)`, `build (ubuntu-24.04)`, `compare` — all `success` |
| Evidence artifact | `nexus-repro-evidence-v1.0.0-rc.10`, artifact id `12762288932`, zip SHA-256 `bb4bb289a75ef553805d825d681881f699f2a81302c024065700ee92d6e41e76` |

## What was proven

The published RC10 tag resolved to the immutable commit above, passed version/tag/lockfile checks, and was rebuilt independently on two runners:

- Ubuntu 22.04, image `20261023.322.3`
- Ubuntu 24.04, image `20261023.334.3`
- Both with Node `v22.22.1`, npm `10.9.4`, rustc/cargo `1.95.0` and the pinned `rust:1.95.0-bookworm` container.

The `compare` job succeeded, confirming the two rebuilds are byte-identical:

| Artifact | SHA-256 |
|---|---|
| `nexus-linux-x86_64-v1.0.0-rc.10.tar.gz` | `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7` |
| `SHA256SUMS` | `760199fcb7e079b356ddbae4f739c74bc356a7b0a7a2edd956b554736651d8fe` |
| `THIRD_PARTY_NOTICES.txt` | `512d808a937aedb6ba84d99b0988502af04c1ea3964f9c0c45114d4ce00053b9` |
| `sbom.cdx.json` | `1a082a2ed29950a9cff828fd00db33de8e182dcb2758846a4e1276849a4a2c3a` |
| `compatibility.json` | `500f4f05d089a3bad911becfd17e26c702747f5a0c9a26b6aac84497e88c1f94` |
| `install.sh` | `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302` |

The full machine-readable record is [repro-evidence.json](repro-evidence.json): source lockfile hashes, empty untracked list, packaging-script hash, both builder manifests and every artifact digest.

## Reproduce

```sh
gh workflow run repro.yml --ref main -f tag=v1.0.0-rc.10
gh run download 40564959805 -n nexus-repro-evidence-v1.0.0-rc.10
```

The workflow checks out the tag, but the packaging tool is the reviewed `main` workflow commit recorded above. This evidence closes the exact-tag execution gap for REQ-REL-114; promoting the ledger row remains the ledger owner's action.
