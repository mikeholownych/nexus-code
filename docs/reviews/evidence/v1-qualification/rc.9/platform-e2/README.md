# RC9 E2 platform and install lifecycle evidence

This evidence covers the exact workflow-produced RC9 installer and package on four prepared Linux images: Ubuntu 22.04, Ubuntu 24.04, Debian 12, and Fedora 40. Containers ran as non-root UID/GID 10001 with disposable `/home/nexus-e2`; no held-out payloads, user data, or credentials were used.

Candidate identity: tag `v1.0.0-rc.9`, source `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566`, release workflow `40370485753`, archive SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`. The exact tagged `install.sh` SHA-256 is in `environment-identities.txt` and matches the RC9 source. Host-side archive checksum and attestations were independently verified in the release artifact work.

## Matrix results

The four platform images each passed these five runtime cases (20 total):

- **No Node, Node 12, and Node 20:** installer printed the Node 22 prerequisite; HOME content was unchanged. Network was disabled.
- **Node 22:** installed RC9 and `nexus --version` reported `1.0.0-rc.9 (4cae11cbc3b0)`.
- **Node 24:** installed RC9 and reported the same identity. Prepared images did not include Node 24, so each OS used its prepared Node 22 image with a read-only Node v24.11.1 runtime overlay; the runtime major and binary digest are recorded.
- On all eight supported-runtime installs, `nexus doctor --json` wrote zero stderr bytes and passed `install.build` and `engine.binary`, with no version warning. It exited 2 because the isolated container had no inference endpoint and no saved sessions/tasks directories yet. The Ubuntu 22.04 Node 22 diagnostic records `endpoint.reachable` fail and two fresh-state warnings. This is not a fully healthy doctor result or provider qualification.
- The container had no trusted GitHub CLI. The installer verified SHA-256 but reported that provenance was not verified inside the container. Host-side attestation verification is separate and already passed.

## Lifecycle results

The `lifecycle/` directory has exact-RC9 disposable-container evidence and the scripts for:

- alpha.2 → RC9 upgrade, rollback to alpha.2, and reinstall to RC9 while preserving synthetic config and state;
- same-version repair after removing a packaged notice file;
- documented manual uninstall removing only Nexus paths while retaining synthetic config/state and an adjacent user file;
- checksum tamper rejection before mutation, with the exact existing RC9 archive and an intentionally incorrect checksum index;
- restore of synthetic state and configuration from a recognized private backup directory;
- incompatible downgrade refusal with launcher and state unchanged;
- failed staging self-test on a synthetic broken candidate, preserving the existing installed RC9 and state;
- a controlled `SIGKILL` of the updater after the journal reached `switched` for a synthetic slow candidate. The retained journal and backup were inspected; `nexus upgrade --recover` restored the verified RC9 package, retained the failed target for diagnosis, and a retry was idempotent.

The SIGKILL case is an application process-death test. It does **not** test sudden power loss or prove hardware/filesystem power-loss durability. The synthetic backup/candidate contents contain no user data.

## Remaining limits

`ACC-PLAT` remains partial until the documented no-version install is run after stable publication. Container doctor did not have a configured inference service. The exact-RC installer container run did not itself verify attestations; separate host-side attestation evidence exists. All earlier incomplete harness runs are retained and classified under `lifecycle/attempts/` or `attempts-incomplete.md`.

All files here, including nested lifecycle logs and scripts, are covered by `SHA256SUMS`.
