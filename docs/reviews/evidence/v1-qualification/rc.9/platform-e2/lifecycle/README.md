# RC9 E2 installer lifecycle observations

All cases ran in disposable Ubuntu 22.04 / Node 22 containers as non-root UID 10001. Each used the exact RC9 installed package and synthetic-only state. The release installer checksum was verified; the container had no trusted GitHub CLI, so provenance was not verified inside the container. Host-side RC9 provenance/attestation was verified separately.

| Case | Result | Evidence |
|---|---|---|
| Install alpha.2 → RC9, rollback to alpha.2, then reinstall RC9 | PASS; version symlinks moved and synthetic config/state hashes were preserved | `ubuntu-22-04-node22-lifecycle.log` |
| Same-version repair after deleting packaged notices | PASS; file restored byte-identically | `ubuntu-22-04-node22-repair.log` |
| Documented manual uninstall | PASS; only Nexus binary/library removed; user state and adjacent user-owned executable retained | `ubuntu-22-04-node22-uninstall.log` |
| Tampered SHA256SUMS against exact RC9 archive | PASS; installer refused before changing existing launcher or synthetic state | `ubuntu-22-04-node22-checksum-tamper.final.log` |
| Restore a recognized private state/config backup | PASS; both stores restored with 0700 directories and 0600 files | `ubuntu-22-04-node22-backup-restore.final.log` |
| Downgrade to alpha.2 with incompatible state schema | PASS; rejected before switching the launcher; state unchanged | `ubuntu-22-04-node22-incompatible-downgrade.log` |
| Broken candidate package self-test | PASS; synthetic candidate reported the wrong version during staging; existing RC9 package and state unchanged | `ubuntu-22-04-node22-upgrade-self-test-failure.log` |
| Interrupted-upgrade journal recovery | PASS; synthetic switched-state journal restored a verified RC9 package, retained failed target for diagnosis, cleaned staging, and was idempotent | `ubuntu-22-04-node22-upgrade-recovery-synthetic.final.log` |
| Updater process crash | PASS as an application process-death test; updater was SIGKILLed after the durable journal reached `switched`; the resulting journal and backup were inspected, `nexus upgrade --recover` restored RC9, and retry was idempotent | `ubuntu-22-04-node22-upgrade-process-crash-recovery.log` |

The last row does not simulate power loss or establish power-loss durability. The test used a synthetic slow candidate derived from the public RC9 package and ran on a disposable container filesystem. Earlier incomplete harness invocations are preserved in `attempts/` and explicitly classified.
