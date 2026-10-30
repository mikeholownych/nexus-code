# RC10 E2: install, doctor and Node preflight matrix

| | |
|---|---|
| Tag | `v1.0.0-rc.10` |
| Commit | `16ee8ca3643824741b6da67936b41f262414fdf0` |
| Installer | release asset `install.sh`, SHA-256 `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302` (verified before the run) |
| Result | **20/20 matrix cells pass; lifecycle cells pass (Ubuntu 22.04, Debian 12, Fedora 40)** |
| Runner | `mike-dev`, Docker; prepared images `nexus-e2/*:prep-182e8addeee0` |
| Run | matrix and Ubuntu lifecycle 2026-10-27 (`run-rc10-e2-matrix.sh`); Debian/Fedora lifecycle and attestation 2026-10-29 |

## Matrix

Four platforms (Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora 40) × two positive Node runtimes (22, 24) and three negative preflight runtimes (none, 12, 20).

**Positive cells (8/8 PASS).** Fresh install with `NEXUS_VERSION=v1.0.0-rc.10`, then:

- `nexus --version` = `1.0.0-rc.10 (16ee8ca36438)`;
- `nexus doctor --json` exits 2 **only** because `endpoint.reachable` fails: the containers have no inference endpoint. stderr is empty, there is no version warning, and `install.build` and `engine.binary` pass; `state.sessions`/`state.tasks` warn as expected on first run because the directories do not exist yet.
- Full doctor findings are archived per cell as `<platform>-<runtime>.doctor.json`.

The positive-cell runner sets `NEXUS_VERIFY_ATTESTATION=0` for every installer invocation, and the 12 negative preflight cells fail before downloading an artifact. Provenance attestation is verified separately against the published artifact (see the attestation cell below).

**Negative cells (12/12 PASS).** Node absent or Node 12/20 → the installer exits non-zero with `Node.js 22 or newer is required`, before any download or state change; the `$HOME` entry hash is unchanged (`preflight=PASS home_unchanged=true`).

## Lifecycle cell (Ubuntu 22.04 / Node 22)

`run-rc10-lifecycle.sh` runs one disposable Ubuntu 22.04 / Node 22 container through installer-driven version switches. Each install step calls the published `install.sh` with `NEXUS_VERSION`; this script does **not** exercise the `nexus upgrade` command.

1. install `v0.1.0-alpha.2` (`0.1.0-alpha.2 (a2e94f306640)`);
2. switch to RC10 (`1.0.0-rc.10 (16ee8ca36438)`) — the alpha.2 version directory is retained;
3. switch back to alpha.2 — the RC10 directory is retained;
4. reinstall RC10;
5. same-version repair: delete the packaged `.provenance.json`, reinstall, and confirm the file is restored byte-identically (hash `b2e03161…c60b37cc` before and after);
6. documented manual uninstall (`rm ~/.local/bin/nexus`, `rm -rf ~/.local/lib/nexus`).

This runner sets `NEXUS_VERIFY_ATTESTATION=0` on every installer invocation; provenance is verified separately (attestation cell below). It seeds markers in `~/.nexus/tasks/item.json`, `~/.config/nexus/config.env` and an adjacent `~/.local/bin` file. Its assertions check all three after the RC10 switch and after uninstall, check the task marker after switching back to alpha.2, and check the package version and repair hash during reinstall/repair; it does not recheck every marker after every intermediate step. Result: **PASS** for the assertions listed above ([log](ubuntu-22-04-node22-lifecycle.log)).

### Lifecycle cells on Debian 12 and Fedora 40

The same lifecycle script runs on the Debian 12 and Fedora 40 / Node 22 images (`lifecycle/debian-12-node22-lifecycle.sh`, `lifecycle/fedora-40-node22-lifecycle.sh`): install alpha.2, installer-driven switch to RC10, rollback to alpha.2, reinstall RC10, same-version repair, documented manual uninstall. Both report **PASS** with the same assertions and retained state/config markers.

Note: alpha.2 predates the `nexus upgrade` command (verified from its installed CLI help), so an "ordinary `nexus upgrade` from alpha.2" is not executable; the alpha.2 row is installer-driven, as the acceptance table specifies. An ordinary updater run must start from a release that ships the updater.

### Additional lifecycle cells (Ubuntu 22.04 / Node 22)

Fixtures were generated from the published RC10 archive (SHA-256 `444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7`) by `lifecycle/prepare-lifecycle-fixtures.sh`; the fixture directory itself is not committed.

| Case | Result | Evidence |
|---|---|---|
| Checksum tamper | Installer refused with `SHA-256 verification failed; no installation was changed.`; launcher symlink and synthetic state marker unchanged | [log](ubuntu-22-04-node22-checksum-tamper.log) |
| Broken candidate self-test | `nexus upgrade --version v1.0.0-rc.10 --force --yes` against a fixture whose launcher reports `9.9.9` failed with `Unpacked binary failed staging self-test`; existing install and user state unchanged | [log](ubuntu-22-04-node22-upgrade-self-test-failure.log) |
| Backup restore | Recognized private `~/.nexus/backups/...` backup restored state and config with 0700 directories / 0600 files | [log](ubuntu-22-04-node22-backup-restore.log) |
| Updater process crash | Updater SIGKILLed after the durable journal reached `switched`; `nexus upgrade --recover` restored the verified RC10 package, retained the failed target for diagnosis, asserted that the journal's staging directory and any `.tmp-upgrade-*` entry were removed, and was idempotent. **Power loss is not tested** | [log](ubuntu-22-04-node22-upgrade-process-crash-recovery.log) |
| Incompatible downgrade | A synthetic release (`prepare-incompatible-fixture.sh`) declares state schema 1; `nexus upgrade --version v1.0.0-rc.4 --allow-downgrade --yes` was refused with `uses state schema version 1, which cannot read current state schema version 2`. Installed version, launcher target and package hash were unchanged and no target directory was created | [log](ubuntu-22-04-node22-incompatible-downgrade.log) |
| Synthetic journal recovery | `run-synthetic-journal-recovery.sh` writes a valid `staged` journal with a staging directory, then a `preparing` journal without one: `nexus upgrade --recover` reports `cleaned_up`, removes staging, keeps the launcher and version, and creates no target directory; a malformed journal is refused with `failed schema or path validation`; the script verifies the installed version string and launcher symlink target are unchanged and that the target install directory remains absent (it does not compare package contents or user state); a second recovery is a no-op | [log](ubuntu-22-04-node22-synthetic-journal-recovery.log) |
| Power-loss durability | **FAIL on the published RC10 artifact.** Power was cut (QEMU SIGKILL, ext4, `cache=none`) at the durable `switched` journal state. After reboot `v1.0.0-rc.10/bin/nexus` is 0 bytes, `nexus --version` prints nothing, and `nexus upgrade --recover` does nothing and exits 0 (a 0-byte launcher is an empty shell script), so the installation cannot repair itself. Cause: the extracted package was never fsynced before the rename and launcher switch. With a CLI containing the fix (PR #333) the same cut leaves a working launcher, recovery rolls back to rc.9, staging is removed, the stale lock is reclaimed, a second recovery is a no-op, and a retry completes to rc.10 | [RC10](ubuntu-22-04-node22-power-loss-durability-verify.log) · [fixed CLI](ubuntu-22-04-node22-power-loss-durability-fixed-cli-verify.log) |
| Power-loss durability (RC11) | **NOT VERIFIED in this evidence package.** A prior draft named RC11 write/verify logs, but those files are absent here; no RC11 result is asserted | — |
| Power-loss durability (RC14) | **PASS on the published RC14 artifact** (`1.0.0-rc.14`, revision `16eeb6ee`, the first published RC built after the fix). A forced same-version reinstall is cut at `switched`; after reboot `bin/nexus` is 580 bytes and `nexus --version` works, `upgrade --recover` restores the verified source package, staging is removed, the stale lock is reclaimed, a second recovery exits 0, and the retry completes | [log](ubuntu-22-04-node22-power-loss-durability-rc14-verify.log) |
| Provenance attestation | `gh attestation verify nexus-linux-x86_64-v1.0.0-rc.10.tar.gz -R mikeholownych/nexus-code` exited 0 on the published archive (SHA-256 `444d0812…b3e7`) with a Sigstore bundle; `--format json` returned a 13,989-byte verification result | [log](attestation-rc10.log) |

The other additional lifecycle scripts do not set `NEXUS_VERIFY_ATTESTATION`; their installer calls use the installer's default `auto` mode. The incompatible-downgrade and synthetic-journal-recovery scripts set it to `0` explicitly. Provenance is verified separately by the attestation cell. Provenance attestation is verified independently by the attestation cell above.

Per-cell logs and results: `results.tsv`; image names and IDs: `prepared-images.json`; digests: `SHA256SUMS`.

## Incompatible-downgrade fixture

`lifecycle/prepare-incompatible-fixture.sh <rc10-archive> <out>` builds a synthetic `v1.0.0-rc.4` release from the published RC10 package (same contents, `compatibility.json` rewritten to declare state schema 1 and the rc.4 archive binding) and writes a local API JSON. `lifecycle/run-incompatible-downgrade.sh` installs RC10 in a container, serves the fixture locally, and asserts the refusal plus an unchanged installation. No published RC declares an older state schema (rc.5–rc.10 all declare 2), which is why the fixture is synthetic.

## Power-loss durability

`lifecycle/powerloss/` builds a 2 GiB ext4 image with rc.9 installed, boots a minimal QEMU/KVM guest, starts the upgrade to rc.10, and `SIGKILL`s the VM when the durable journal reaches `switched` — package in place and launcher switched, runtime verification not yet run. Nothing is synced first, and the image is mounted `cache=none`, so dirty page cache is lost exactly as in a power cut. The second boot dumps the journal, upgrade log and package directories, parses every JSON state file, runs `nexus upgrade --recover`, and asserts the rollback, staging removal, stale-lock reclamation and idempotence, then retries the upgrade to completion.

On the published RC10 artifact the cell **fails**: the extracted package's file data was never fsynced, so the rename and launcher switch survived while the payload did not. `v1.0.0-rc.10/bin/nexus` is 0 bytes, `nexus --version` prints nothing, and `nexus upgrade --recover` exits 0 without doing anything, because a 0-byte launcher is an empty shell script. The upgrade is performed by the installed rc.9 CLI, and the missing flush is in that running CLI. No RC11 result is asserted in this evidence package because the two log artifacts named by the prior draft are absent.

The fix (PR #333) flushes every extracted file and directory before the switch. `NEXUS_POWERLOSS_BASELINE_DIST` runs the same published artifacts through a CLI containing the fix (the guest records the SHA-256 of the dist's sorted file manifest); that cut leaves a working launcher, recovery rolls back to rc.9, and the retry completes to rc.10. This demonstrates the fix; it is not qualification. The cell can only pass for a release whose own artifact contains the fix.

The harness needs KVM. Under TCG emulation the CLI's 5 s package-health probe can exceed its budget on a cold start and produce a false failure unrelated to durability.

## Synthetic journal states

`lifecycle/run-synthetic-journal-recovery.sh` writes journals conforming to the real schema (fixed source/target paths, staging name and timestamps) for the `staged` and `preparing` states, plus a malformed file, so recovery can be exercised without killing a live updater. It asserts the `cleaned_up` action, staging removal, launcher/version stability, refusal of the malformed journal, and idempotence.

## Reproduce

```sh
cp install.sh /tmp/nexus-install.sh   # release asset v1.0.0-rc.10
bash docs/reviews/evidence/v1-qualification/rc.10/platform-e2/run-rc10-e2-matrix.sh
```

The positive cells use Docker `--network bridge` to download the published RC10 release assets; the negative cells run `--network none`. The script refuses to start unless the installer hash matches the one recorded here.

## Scope and residuals

- This covers the fresh-install / doctor / Node-preflight matrix plus the lifecycle cells (Ubuntu 22.04, Debian 12, Fedora 40 / Node 22) for E2 (ACC-PLAT) on RC10: install, installer-driven version switch and rollback, reinstall, repair and uninstall; checksum tamper; broken-candidate self-test; backup restore; updater process-crash recovery with staging cleanup; incompatible downgrade from a synthetic state-schema-1 release; synthetic-journal recovery from early transaction states and a malformed journal; and provenance-attestation verification. An ordinary successful `nexus upgrade` from alpha.2 is not executable because alpha.2 has no updater command; the alpha.2 row is installer-driven. Power-loss durability is tested rather than assumed: it **fails on RC10**, is not verified for RC11 in this package because its log artifacts are absent, and **passes on RC14**, the first published RC built after the fix.
- `endpoint.reachable` failing is expected in the isolated containers and is not a product failure; the same doctor run on a host with a configured gateway is the installed-RC provider evidence path.
- Images were prepared for the RC9 matrix (`prep-182e8addeee0`). `prepared-images.json` records each cell label, image reference and image ID; it does not store separate base-distribution or Node-version fields. Positive-cell logs print the container's `node --version`; Node 24 cells mount the host Node v24.11.1 runtime into the Node 22 image.
