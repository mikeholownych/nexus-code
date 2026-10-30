# RC14 E2 platform installer evidence (partial)

This packet records RC14 fresh-install and prerequisite-preflight cases plus four targeted lifecycle scenarios. Review dispositions for the exact packet and enclosing manifest are tracked separately in [`../platform-e2-lifecycle-review.md`](../platform-e2-lifecycle-review.md), outside this checksummed directory. The current corrected lifecycle packet is awaiting a fresh exact-digest review. It does not complete ACC-PLAT: upgrade, rollback, repair, uninstall, tamper, backup restore, self-test failure, crash recovery, and incompatible-downgrade rows are not established across the full E2 matrix. The four additional scenarios are limited to Ubuntu 22.04 / Node 22.23.3 and do not satisfy the remaining platform/runtime cells.

## Bound artifact

- Tag: `v1.0.0-rc.14`
- Source commit: `16eeb6eeffe7fc0bae234aa34dcb671a6ba5ff99`
- Linux archive SHA-256: `52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7`
- Release installer SHA-256: `b243cda661eb0a57890435cfa2170fb50ea8e507aeec595d364d3f2ce71c8125`
- Node 24 runtime: `v24.21.0`, binary SHA-256 recorded in `manifest.json`
- Docker: `29.9.2`
- Prepared E2 image tags, immutable image IDs, and preparation input labels are in `prepared-images.json`.
- `assets/SHA256SUMS` checks the bundled `install.sh` and `compatibility.json`. The RC14 archive is intentionally not duplicated here; its exact digest is recorded above and in `manifest.json`, and the external public-release-asset comparison is preserved in `assets-check.log`.

## Results

The 20 cells cover four platforms: Ubuntu 22.04, Ubuntu 24.04, Debian 12, and Fedora 40. All containers ran as the prepared non-root `nexus-e2` user (UID/GID 10001).

| Runtime | Cells | Result |
|---|---:|---|
| No Node | 4 | PASS: installer refused before download/state changes; HOME tree and file hashes unchanged |
| Node 12.22.12 | 4 | PASS: clear Node 22 minimum message; HOME unchanged |
| Node 20.20.2 | 4 | PASS: refused as unsupported under DEC-12; HOME unchanged |
| Node 22.23.3 | 4 | PASS: installed exact RC14; launcher identity matched; doctor stderr empty, install/build and engine checks passed, no version warning |
| Node 24.21.0 | 4 | PASS: installed exact RC14; launcher identity matched; doctor stderr empty, install/build and engine checks passed, no version warning |

Each negative cell ran with Docker networking disabled. Its snapshot covered path names, entry types, modes, and hashes of every file under HOME before and after installer invocation. Per-cell stdout, stderr, and exit status are in `preflight/`.

Each positive cell invoked the release `install.sh` with `NEXUS_VERSION=v1.0.0-rc.14` and `NEXUS_VERIFY_ATTESTATION=auto`, then checked `nexus --version` and `nexus doctor --json`. The expected launcher identity was `1.0.0-rc.14 (16eeb6eeffe7)`. Raw doctor JSON, stderr, runner output, and exit status are preserved under `node22/` and `node24/`.

The doctor command returned exit status 2 in these clean, unconfigured images because the default local inference endpoint was unreachable (and fresh state directories are absent). The acceptance check for this E2 row is specifically that the installed version is correct, doctor emits no version warning, and stderr is empty; the packet does not characterize the doctor result as fully healthy.

The containers did not have a trusted GitHub CLI, so installer mode `auto` verified the downloaded checksum and printed its documented “provenance was not verified” warning. The RC14 archive and checksum attestations were independently verified on the host and are recorded in the parent RC14 evidence directory; these container runs do not count as attestation verification.

## Targeted lifecycle cases

The [lifecycle-targeted packet](lifecycle-targeted/README.md) records four additional cases against the exact published RC14 archive: candidate staging self-test refusal, updater process-crash recovery, backup restore, and incompatible-downgrade refusal. A prior independent review accepted an earlier checksum of that subpacket; after checksum corrections and reruns, fresh review is pending. See the [review disposition](../platform-e2-lifecycle-review.md). The process-crash case is not a power-loss test. These results do not complete the lifecycle matrix across platforms or runtimes.

## Acceptance wording reconciliation

DEC-12 sets Node 22 as the minimum and explicitly supersedes the earlier Node 20 decision. The E2 environment and §7 table had still described Node 20 as a fresh-install runtime. `docs/v1.0.0/ACCEPTANCE.md` now classifies Node 12 and 20 as negative prerequisite cases and Node 22 and 24 as supported install runtimes. This aligns the matrix with DEC-12 without changing product support or thresholds.

## Reproduction

Use the public RC14 assets and the exact image IDs in `prepared-images.json`. For positive cells, run the release installer as a non-root user with the tagged version and verify launcher identity and the doctor predicates stated above. For negative cells, use `--network none`, seed a marker in the image user's HOME, snapshot the complete tree and file hashes, invoke the installer, and require both the Node 22 prerequisite message and an unchanged post-run snapshot. Do not interpret this partial fresh-install/preflight packet as completion of the remaining ACC-PLAT lifecycle cases.

The outer `SHA256SUMS` file binds every packet file under this directory except the outer manifest itself, including nested checksum manifests, fixture payloads, per-cell output, and the lifecycle-targeted packet. Verify it from a clean checkout before relying on the archived outputs.
