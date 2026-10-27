# RC10 E2: install, doctor and Node preflight matrix

| | |
|---|---|
| Tag | `v1.0.0-rc.10` |
| Commit | `16ee8ca3643824741b6da67936b41f262414fdf0` |
| Installer | release asset `install.sh`, SHA-256 `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302` (verified before the run) |
| Result | **20/20 cells pass** |
| Runner | `mike-dev`, Docker; prepared images `nexus-e2/*:prep-182e8addeee0` |
| Run | 2026-10-27, `run-rc10-e2-matrix.sh` |

## Matrix

Four platforms (Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora 40) × two positive Node runtimes (22, 24) and three negative preflight runtimes (none, 12, 20).

**Positive cells (8/8 PASS).** Fresh install with `NEXUS_VERSION=v1.0.0-rc.10`, then:

- `nexus --version` = `1.0.0-rc.10 (16ee8ca36438)`;
- `nexus doctor --json` exits 2 **only** because `endpoint.reachable` fails: the containers have no inference endpoint. stderr is empty, there is no version warning, and `install.build` and `engine.binary` pass; `state.sessions`/`state.tasks` warn as expected on first run because the directories do not exist yet.
- Full doctor findings are archived per cell as `<platform>-<runtime>.doctor.json`.

**Negative cells (12/12 PASS).** Node absent or Node 12/20 → the installer exits non-zero with `Node.js 22 or newer is required`, before any download or state change; the `$HOME` entry hash is unchanged (`preflight=PASS home_unchanged=true`).

Per-cell logs and results: `results.tsv`; image names and IDs: `prepared-images.json`; digests: `SHA256SUMS`.

## Reproduce

```sh
cp install.sh /tmp/nexus-install.sh   # release asset v1.0.0-rc.10
bash docs/reviews/evidence/v1-qualification/rc.10/platform-e2/run-rc10-e2-matrix.sh
```

The positive cells use Docker `--network bridge` to download the published RC10 release assets; the negative cells run `--network none`. The script refuses to start unless the installer hash matches the one recorded here.

## Scope and residuals

- This is the **fresh-install / doctor / Node-preflight** portion of E2 (ACC-PLAT) for RC10. Upgrade alpha.2 → RC, rollback, repair, uninstall, checksum-tamper, attestation, self-test failure, crash recovery and backup-restore are separate lifecycle cells; the RC9 lifecycle scripts live under `../rc.9/platform-e2/lifecycle/` and were not re-run against RC10 here.
- `endpoint.reachable` failing is expected in the isolated containers and is not a product failure; the same doctor run on a host with a configured gateway is the installed-RC provider evidence path.
- Images were prepared for the RC9 matrix (`prep-182e8addeee0`); their base distro and Node versions are recorded in `prepared-images.json`. Node 24 cells mount the host Node v24.11.1 runtime into the Node 22 image.
