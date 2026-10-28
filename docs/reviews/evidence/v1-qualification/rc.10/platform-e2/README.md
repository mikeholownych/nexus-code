# RC10 E2: install, doctor and Node preflight matrix

| | |
|---|---|
| Tag | `v1.0.0-rc.10` |
| Commit | `16ee8ca3643824741b6da67936b41f262414fdf0` |
| Installer | release asset `install.sh`, SHA-256 `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302` (verified before the run) |
| Result | **20/20 matrix cells pass; lifecycle cell pass** |
| Runner | `mike-dev`, Docker; prepared images `nexus-e2/*:prep-182e8addeee0` |
| Run | 2026-10-27, `run-rc10-e2-matrix.sh` |

## Matrix

Four platforms (Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora 40) × two positive Node runtimes (22, 24) and three negative preflight runtimes (none, 12, 20).

**Positive cells (8/8 PASS).** Fresh install with `NEXUS_VERSION=v1.0.0-rc.10`, then:

- `nexus --version` = `1.0.0-rc.10 (16ee8ca36438)`;
- `nexus doctor --json` exits 2 **only** because `endpoint.reachable` fails: the containers have no inference endpoint. stderr is empty, there is no version warning, and `install.build` and `engine.binary` pass; `state.sessions`/`state.tasks` warn as expected on first run because the directories do not exist yet.
- Full doctor findings are archived per cell as `<platform>-<runtime>.doctor.json`.

The positive-cell runner sets `NEXUS_VERIFY_ATTESTATION=0` for every installer invocation. This E2 record therefore does **not** verify release provenance attestations. The 12 negative preflight cells fail before downloading an artifact and do not exercise attestation verification either.

**Negative cells (12/12 PASS).** Node absent or Node 12/20 → the installer exits non-zero with `Node.js 22 or newer is required`, before any download or state change; the `$HOME` entry hash is unchanged (`preflight=PASS home_unchanged=true`).

## Lifecycle cell (Ubuntu 22.04 / Node 22)

`run-rc10-lifecycle.sh` runs one disposable Ubuntu 22.04 / Node 22 container through installer-driven version switches. Each install step calls the published `install.sh` with `NEXUS_VERSION`; this script does **not** exercise the `nexus upgrade` command.

1. install `v0.1.0-alpha.2` (`0.1.0-alpha.2 (a2e94f306640)`);
2. switch to RC10 (`1.0.0-rc.10 (16ee8ca36438)`) — the alpha.2 version directory is retained;
3. switch back to alpha.2 — the RC10 directory is retained;
4. reinstall RC10;
5. same-version repair: delete the packaged `.provenance.json`, reinstall, and confirm the file is restored byte-identically (hash `b2e03161…c60b37cc` before and after);
6. documented manual uninstall (`rm ~/.local/bin/nexus`, `rm -rf ~/.local/lib/nexus`).

This runner sets `NEXUS_VERIFY_ATTESTATION=0` on every installer invocation, so it does not verify provenance attestations. It seeds markers in `~/.nexus/tasks/item.json`, `~/.config/nexus/config.env` and an adjacent `~/.local/bin` file. Its assertions check all three after the RC10 switch and after uninstall, check the task marker after switching back to alpha.2, and check the package version and repair hash during reinstall/repair; it does not recheck every marker after every intermediate step. Result: **PASS** for the assertions listed above ([log](ubuntu-22-04-node22-lifecycle.log)).

### Additional lifecycle cells (Ubuntu 22.04 / Node 22)

Fixtures were generated from the published RC10 archive (SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`) by `lifecycle/prepare-lifecycle-fixtures.sh`; the fixture directory itself is not committed.

| Case | Result | Evidence |
|---|---|---|
| Checksum tamper | Installer refused with `SHA-256 verification failed; no installation was changed.`; launcher symlink and synthetic state marker unchanged | [log](ubuntu-22-04-node22-checksum-tamper.log) |
| Broken candidate self-test | `nexus upgrade --version v1.0.0-rc.10 --force --yes` against a fixture whose launcher reports `9.9.9` failed with `Unpacked binary failed staging self-test`; existing install and user state unchanged | [log](ubuntu-22-04-node22-upgrade-self-test-failure.log) |
| Backup restore | Recognized private `~/.nexus/backups/...` backup restored state and config with 0700 directories / 0600 files | [log](ubuntu-22-04-node22-backup-restore.log) |
| Updater process crash | Updater SIGKILLed after the durable journal reached `switched`; `nexus upgrade --recover` restored the verified RC10 package, retained the failed target for diagnosis, and was idempotent. The script does not separately assert staging-directory cleanup. **Power loss is not tested** | [log](ubuntu-22-04-node22-upgrade-process-crash-recovery.log) |

These four additional lifecycle scripts do not set `NEXUS_VERIFY_ATTESTATION`; their installer calls use the installer's default `auto` mode. When the trusted GitHub CLI is unavailable, the installer warns that provenance was not verified. This E2 evidence does not establish successful attestation verification.

Per-cell logs and results: `results.tsv`; image names and IDs: `prepared-images.json`; digests: `SHA256SUMS`.

## Reproduce

```sh
cp install.sh /tmp/nexus-install.sh   # release asset v1.0.0-rc.10
bash docs/reviews/evidence/v1-qualification/rc.10/platform-e2/run-rc10-e2-matrix.sh
```

The positive cells use Docker `--network bridge` to download the published RC10 release assets; the negative cells run `--network none`. The script refuses to start unless the installer hash matches the one recorded here.

## Scope and residuals

- This covers the fresh-install / doctor / Node-preflight matrix plus the Ubuntu 22.04 / Node 22 lifecycle cells for E2 (ACC-PLAT) on RC10: install, installer-driven version switch and rollback, reinstall, repair and uninstall; checksum tamper; broken-candidate self-test; backup restore; and updater process-crash recovery. It does not demonstrate an ordinary successful `nexus upgrade` from alpha.2 to RC10. This E2 record does not verify provenance attestation; power-loss durability, synthetic-journal recovery, incompatible downgrade and lifecycle on other platforms remain separate.
- `endpoint.reachable` failing is expected in the isolated containers and is not a product failure; the same doctor run on a host with a configured gateway is the installed-RC provider evidence path.
- Images were prepared for the RC9 matrix (`prep-182e8addeee0`). `prepared-images.json` records each cell label, image reference and image ID; it does not store separate base-distribution or Node-version fields. Positive-cell logs print the container's `node --version`; Node 24 cells mount the host Node v24.11.1 runtime into the Node 22 image.
