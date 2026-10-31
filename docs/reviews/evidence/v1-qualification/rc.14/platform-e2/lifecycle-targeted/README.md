# RC14 targeted E2 lifecycle scenarios — candidate evidence

Status: the review record ACCEPTs the prior exact lifecycle and enclosing platform manifest digests; this README edit changes those digests and requires fresh independent review. This is not whole E2, §7 install-matrix, or release acceptance.

## Artifact and environment

- Published candidate: `v1.0.0-rc.14`, tag object `03770c12a30af830f392eb916122b864c12cf322`, source commit `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99`.
- Published archive SHA-256: `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`. The official release installer downloaded that archive and verified its `SHA256SUMS` before installing.
- The mounted `install.sh` is the published RC14 asset, SHA-256 `b243cda661eb0a57890435cfa2170fb50ea8e507aeec595d364d3f2ce71c8125`; this matches both the release asset digest and `16eeb6ee:install.sh`.
- Container image: `nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0`, image ID `sha256:5246cc3f1ab808f2b6295a4424679ca91cfadce41e25410b22e69ec2026a192d`, Node `v22.23.3`. Each scenario used a disposable `--rm` container and its own container HOME/XDG tree. No user HOME or credentials were mounted. Test state and downgrade metadata were synthetic.
- Docker bridge networking was used for public release downloads and loopback-only fixture servers. No inference gateway or held-out corpus was used.
- The container lacks `gh`; the installer therefore emitted its provenance-not-verified warning while confirming SHA-256. Provenance verification for the published archive and `SHA256SUMS` is separately recorded in the RC14 artifact evidence.

## Results

| Scenario | Result | Observation |
|---|---|---|
| Upgrade staging self-test failure | PASS | The deliberately invalid candidate failed staging. Assertions confirmed the launcher symlink, `lib/cli/dist/index.js` digest, synthetic state marker, and installed version were unchanged. The entire installed package was not hashed. |
| Updater process crash and recovery | PASS | SIGKILL returned 137 after the durable `switched` checkpoint. `nexus upgrade --recover` restored the RC14 CLI entrypoint digest and version, retained the failed target, removed staging, preserved user state, and a second recovery was a no-op. The runner explicitly says `POWER_LOSS_NOT_TESTED`; it does not establish byte identity for the whole package. |
| Backup restore | PASS | Synthetic state and config contents were restored. Assertions checked the two restored files at mode 0600 and the tasks directory at mode 0700; other backup or restored directory modes were not asserted. |
| Incompatible downgrade | PASS | RC14 schema v2 refused the synthetic RC4 schema v1 downgrade even with `--allow-downgrade`; assertions confirmed launcher path/version, the CLI entrypoint digest, and that no RC4 install directory was created. The entire installed package was not hashed. |

These results cover only the four listed Ubuntu 22.04/Node 22 scenarios. Scenario assertions are limited to the exact values described in the table; they do not hash every byte of the installed package or inspect every restored directory permission. The synthetic release/API fixture inputs are included under `fixtures/` and bound by `fixtures/SHA256SUMS`; scripts mount those packet-contained inputs. See `FIXTURE-PROVENANCE.md` for their origins and construction limits.

They do not establish QEMU/KVM power-loss durability, other platform rows, provider or standalone qualification, held-out quality, or overall RC acceptance.

## Reproduction after independent review

On 2026-10-30, all four scenarios were rerun after binding the synthetic fixtures into this packet. The latest counted outputs are `self-test-failure-rerun-2026-10-30T1337Z.out`, `process-crash-recovery-rerun-2026-10-30T1341Z.out`, `backup-restore-rerun-2026-10-30T1342Z.out`, and `incompatible-downgrade-rerun-2026-10-30T1342Z.out`; each reports PASS. Two intervening process-crash retries produced zero-byte logs and no counted result; they and their undetermined cause are recorded under `attempts/`. The crash runner now uses a bounded 3,000-attempt wait for the switched journal state and prints diagnostic state on timeout. They used the artifact, image, and limited assertion scope above; the process-crash cell explicitly does not test power loss. `SHA256SUMS` binds the packet, scripts, fixture manifests, fixtures, and these outputs. The downgrade runner's host-side installer check now verifies the packet's own `install.sh`; the revised runner was rerun after that change.

## Attempts retained

A preliminary run in `/var/tmp/nexus-rc14-e2-recovered.YfKLDG` used a local installer script that differed from the RC14 asset by omitting three `sync` calls. Its results are excluded from this evidence. In the first attempt in this directory, the copied backup runner failed before container startup because it referenced an undefined `$here`; the copied runner was corrected to mount this directory's verified installer, and the backup scenario then passed. The incomplete preliminary artifacts remain preserved. A later packet rerun was interrupted with SIGINT after a separate local RC14 E2 platform matrix was discovered; that attempt produced no counted result and is documented in `attempts/2026-10-30-overlap-abort.txt`.

A zero-byte file named `self-test-failure-rerun-2026-10-30T1336Z.out` was found during independent review. No command, exit status, or execution record was available to establish it as scenario output, so it has been removed from the packet and is not counted as a run. The cause of that empty byproduct was not captured. The independently recorded overlap-abort attempt above remains preserved with its known cause and exit status.

The packet's review disposition is tracked outside the checksummed packet in [`../../platform-e2-lifecycle-review.md`](../../platform-e2-lifecycle-review.md), so recording a reviewer decision does not change the artifact being reviewed.
