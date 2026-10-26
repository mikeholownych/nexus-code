# RC9 E2 installer and runtime preflight evidence

This rerun evaluates the exact workflow-produced RC9 installer and package on the four prepared E2 Linux images: Ubuntu 22.04, Ubuntu 24.04, Debian 12, and Fedora 40. Image labels identify the environment-preparation inputs. Containers ran as non-root UID/GID 10001 with the image's isolated `/home/nexus-e2`; each invocation used a disposable container. No held-out payloads, user data, or credentials were used.

Candidate identity: tag `v1.0.0-rc.9`, source `4cae11cbc3b0eab9bd6f56df7cc34e946b5dc566`, release workflow `40370485753`, archive SHA-256 `35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb`. The exact tagged `install.sh` SHA-256 is recorded in `environment-identities.txt` and matches the RC9 source checkout. Host-side archive checksum and attestation verification are recorded in the release evidence.

## Results

- **No Node:** all four images printed the Node 22 prerequisite message and the installer-preflight runner confirmed the image HOME content was unchanged. Containers had `--network none`.
- **Node 20:** all four images rejected Node 20 with the Node 22 prerequisite message, before network access; HOME content was unchanged.
- **Node 22:** all four images installed RC9 and `nexus --version` reported `1.0.0-rc.9 (4cae11cbc3b0)`.
- **Node 24:** all four OS images installed RC9 and reported the same identity. The E2 preparation did not include Node 24-tagged images, so the runner used each OS's prepared Node 22 image and overlaid a read-only Node v24.11.1 runtime directory; the runtime major is asserted and the binary digest is recorded.
- On all eight supported-runtime installs, `nexus doctor --json` wrote zero stderr bytes and passed `install.build` and `engine.binary`; it reported no version warning. Its exit status was 2 because the isolated containers deliberately had no inference endpoint (`endpoint.reachable` fail) and no saved sessions/tasks directories yet (two warnings), confirmed in `ubuntu-22-04-doctor-summary.log`. Other platform logs retain the empty-stderr and required build/engine checks. This is not recorded as a fully healthy doctor result or as provider qualification.
- The container lacked a trusted GitHub CLI, so the installer verified the downloaded SHA-256 but reported that build provenance was not verified. This does not replace or invalidate the separate host-side attestation verification; it means the container run itself is not evidence for in-container attestation verification.

This is a fresh-install and unsupported-runtime preflight slice of ACC-PLAT. It does not establish the remaining upgrade, rollback, repair, uninstall, checksum-tamper, crash-recovery, backup-restore, or downgrade rows. The broader ACC-PLAT gate remains partial. `no-version` installation after stable publication is not run because v1.0.0 is not yet published.

`attempts-incomplete.md` classifies earlier harness-only invocations. The final per-combination logs, runner, prepared-image identities, runtime identity and SHA256SUMS are retained here. Every file is covered by `SHA256SUMS`.
