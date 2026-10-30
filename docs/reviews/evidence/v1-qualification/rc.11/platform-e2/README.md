# RC11 E2 platform and Node installer matrix

## Disposition

**Installer/platform matrix: PASS (20/20 cells). Selected lifecycle cases: PASS. Full ACCEPTANCE.md §7 E2: INCOMPLETE.**

This run covers fresh installation and preflight behavior for the exact public RC11 artifact. It does not cover the §7 upgrade, rollback, repair, uninstall, checksum-tamper, attestation, upgrade-recovery, or backup-restore cases; those remain required and are not inferred from this matrix.

## Exact candidate and execution

- Tag: `v1.0.0-rc.11`
- Source commit: `8d4e5319f1a31ee67e31d3edb6b44c2e7d9ecb05`
- Installed version identity: `1.0.0-rc.11 (8d4e5319f1a3)`
- Official installer SHA-256: `5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302`
- Public archive SHA-256: `72d73f3565a48fb83d0c9a13a93fe38c2a3ae8af75184dab3af73c0b749c4053`
- Artifact workflow: [40976048056](https://github.com/mikeholownych/nexus-code/actions/runs/40976048056) succeeded on the exact RC11 source commit and published the attested archive.
- Cross-runner reproduction: [40980085377](https://github.com/mikeholownych/nexus-code/actions/runs/40980085377) succeeded for Ubuntu 22.04 and 24.04 and compared both builds with the public RC11 archive.
- Runner: Linux x86_64; each cell ran in a fresh, pinned Docker image as non-root `nexus-e2` (uid/gid 10001).
- Final validated run interval: `2026-10-30T01:23:01Z`–`2026-10-30T01:24:23Z` (rerun after making HOME snapshot archive creation fail closed on tar or hash errors).
- Runner: `run-rc11-e2-matrix.sh`; it used `--pull=never`. Negative preflight cells had networking disabled; positive installs used the bridge to fetch the public RC11 release asset. Positive installs disabled the installer attestation command because `gh` authentication is not provisioned in these containers; the same official installer SHA was checked before the matrix, and the RC11 artifact's attestation/provenance is covered by the separately recorded release workflow and desktop-install evidence.

## Results

| OS image | No Node | Node 12 (extra negative control) | Node 20 | Node 22 | Node 24 |
|---|---:|---:|---:|---:|---:|
| Ubuntu 22.04 | PASS | PASS | PASS | PASS | PASS |
| Ubuntu 24.04 | PASS | PASS | PASS | PASS | PASS |
| Debian 12 | PASS | PASS | PASS | PASS | PASS |
| Fedora 40 | PASS | PASS | PASS | PASS | PASS |

The acceptance-required rows are no Node, Node 20, Node 22, and Node 24 on each OS. Node 12 is an additional negative preflight control. Unsupported-runtime cells verified the actionable Node 22 minimum error and a content-aware `$HOME` snapshot unchanged across preflight. The snapshot includes file contents, paths, file types, permissions, ACLs, extended attributes, and symlink targets. Node 22/24 cells installed the package, verified the exact launcher version, and ran `nexus doctor --json`; the doctor output had empty stderr, no version-related warning/failure, and passing `install.build` and `engine.binary` checks.

The isolated Docker images have an endpoint configured at `http://localhost:1234/v1`, but no provider service is running or reachable inside those containers. Doctor therefore returned exit 2 and reported `endpoint.reachable` as FAIL in each positive cell, while `endpoint.configured` passed. This is an environment/provider finding, not an installer or package-version failure; it is retained in raw output and is not represented as a fully healthy doctor run. The §7 fresh-install condition in this matrix (exact installed version, no version warning, empty stderr) passed. Provider checks are a separate qualification lane.

All 20 cells completed, with `failures=0`. The actual immutable image IDs are recorded in `prepared-images.json`; each cell's complete command output is retained in `<cell>.log`, and positive-cell doctor JSON is retained separately.

## Selected lifecycle cases

These cases ran against the exact RC11 installer and package. Logs and adapted commands are under `lifecycle/`.

| Case | Environment | Result and evidence |
|---|---|---|
| Installer-driven alpha.2 → RC11 switch, rollback to alpha.2, reinstall RC11, repair a deleted package file, and documented manual uninstall | Ubuntu 22.04, Ubuntu 24.04, Debian 12, Fedora 40; Node 22 | PASS on all four images. User state, configuration, and adjacent user file markers remain intact; repair restores `.provenance.json` byte-identically. See the four `*-node22-lifecycle.log` files. This exercises installer version switching, not the `nexus upgrade` command. |
| Successful updater upgrade | Ubuntu 22.04; Node 22 | PASS. Installed RC10, then ran `nexus upgrade --version v1.0.0-rc.11 --yes`; verified RC11 launcher identity, both release directories retained, and state/config/adjacent-file markers and private modes preserved. |
| Checksum tampering | Ubuntu 22.04; Node 22 | PASS. Refused before changing the installed launcher or user state. |
| Same-version reinstall when the candidate package fails checksum verification | Ubuntu 22.04; Node 22 | PASS. Reinstall of RC11 was attempted from a checksum-tampered RC11 release fixture; the installer refused and the existing package entry point, launcher, and user state retained their pre-attempt hashes/identity. See `lifecycle/ubuntu-22-04-node22-checksum-tamper.log`. |
| Broken candidate staging self-test | Ubuntu 22.04; Node 22 | PASS. The candidate failed staging version validation; existing installation and state remained unchanged. |
| Backup restore | Ubuntu 22.04; Node 22 | PASS. Recognized backup restored config and state with required private modes. |
| Synthetic journal recovery | Ubuntu 22.04; Node 22 | PASS. Staged/preparing journals cleaned up, malformed journal refused, recovery idempotent. |
| Incompatible downgrade | Ubuntu 22.04; Node 22 | PASS. Schema-1 target refused against current schema 2; installed version, launcher, and package stayed unchanged. The target is a locally generated fixture derived from RC11 with only its compatibility metadata changed. |
| Updater process crash and recovery | Ubuntu 22.04; Node 22 | PASS. SIGKILL after the durable `switched` state; recovery restored the verified source package, removed staging, retained the failed target for diagnosis, and was idempotent. This is process-kill evidence, not power-loss testing. |

The lifecycle scripts that use `NEXUS_VERIFY_ATTESTATION=0` do so because the disposable containers have no GitHub CLI. The artifact workflow above produced provenance; a separate installed desktop record verifies it. These fixture tests do not claim full provider or evaluator qualification.

## Reproduction

From this directory, with Docker and the pinned images already present:

```sh
bash run-rc11-e2-matrix.sh
```

The script checks the installer digest before execution. The installer path (`/var/tmp/nexus-rc11-e2-platform/installer/install.sh`), required Node 24 runtime path (`/home/mike/.local/node-v24.11.1-linux-x64`), and evidence output directory are host-specific constants at the top of the script; adjust only in a separately reviewed reproduction copy, not in this recorded run.

## Not covered

`gh attestation verify` now passes for the exact RC11 archive under the repository, release workflow, tag, and source-commit constraints. The command ran on the authenticated qualification host, not inside the clean-container matrix; see `attestation-verification.json`. The §7 no-version installer invocation remains pending because it applies after stable v1.0.0 publication. Full ACC-PLAT remains open pending independent review and reconciliation against every §7 row. No host power-loss test was run.
