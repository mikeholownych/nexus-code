# Power-loss durability cell

The only E2 lifecycle cell that cannot be exercised with a process kill: it cuts
power to a guest VM while an upgrade is in flight, then boots the same disk and
runs recovery.

## What it does

1. Builds a 2 GiB ext4 image with published v1.0.0-rc.9 installed.
2. Boots a minimal guest (busybox + Node + the packaged binaries) under
   QEMU/KVM, starts `nexus upgrade --version v1.0.0-rc.10`, and watches the
   durable journal.
3. When the journal reaches `switched` (package in place, launcher switched,
   runtime verification not yet run), the guest powers off with no sync and the
   harness `SIGKILL`s QEMU. Nothing is flushed first.
4. Boots the same image again: dumps the journal, the upgrade log and the
   package directories, checks every JSON state file parses, runs
   `nexus upgrade --recover`, and asserts the rollback, staging removal, stale
   lock reclamation and idempotence.
5. Retries the same upgrade to completion, proving the installation is usable
   afterwards.

The guest's root filesystem is the only disk, mounted with `cache=none`
(`if=virtio`), so a SIGKILL is a real power cut for the guest: dirty page cache
is lost, while anything that reached the image stays.

## Requirements

- `qemu-system-x86_64` with KVM. **Run with KVM.** Under TCG emulation the CLI's
  5 s package-health probe can time out on a cold start, which produces a false
  failure unrelated to durability.
- A kernel image readable by the running user (`/boot/vmlinuz-*` is usually
  `0600`; copy it and pass `NEXUS_POWERLOSS_KERNEL`).
- `busybox`, `/usr/bin/flock`, and a Node.js >= 22 binary.
- Root (the harness loop-mounts the image and calls `sudo mount`/`sudo umount`), or a
  user with read/write access to `/dev/kvm` plus passwordless sudo for mounts.
- `mkfs.ext4`, `cpio`, `qemu-img`, `gzip` and `ldd` on the host.
- The published rc.9 and rc.10 assets (`fetch-assets.sh`).

```sh
./fetch-assets.sh /var/tmp/nexus-powerloss-assets
sudo -E env NEXUS_POWERLOSS_KERNEL=/var/tmp/vmlinuz-readable \
  NEXUS_POWERLOSS_NODE=$(command -v node) \
  ./run-power-loss-durability.sh
```

Logs are written to the platform-e2 directory as
`ubuntu-22-04-node22-power-loss-durability{,-SUFFIX}-{write,verify}.log`, with
serial console `CR` bytes stripped on copy.

Tags and archive digests are pinned in the script (rc.9 → rc.10 by default) and
can be overridden with `NEXUS_POWERLOSS_{BASE,TARGET}_{TAG,SHA}` for another
candidate. Tag overrides must be v-prefixed semantic versions. The optional
`NEXUS_POWERLOSS_LOG_SUFFIX` must be a safe filename component of at most 64
letters, digits, dots, underscores, or hyphens, and cannot contain `..`.

The script creates a fresh private mode-0700 work directory under `/var/tmp`
for each default run. `NEXUS_POWERLOSS_WORK` may name a new absolute work path;
it is never recursively deleted or reused. Its parent must be `/var/tmp` (mode
1777) or an existing mode-0700 directory owned by the invoking user. Preserve
the resulting directory when diagnosing a failed run; remove it manually only
after verifying the exact path and retaining any needed logs.
When replacing a baseline `dist`, the runner resolves the target through any
symlinks and refuses deletion unless the resolved path remains inside the
mounted image.

## Result on the published RC10 artifact: FAIL

`v1.0.0-rc.10/bin/nexus` is **0 bytes** after the cut (the verify log prints the
size). The package was renamed into place and the launcher switched, but its
file data was never fsynced, so the power loss left the launcher pointing at
empty files. `nexus --version` prints nothing, and `nexus upgrade --recover`
**exits 0 without doing anything** — a 0-byte launcher is an empty shell script,
so the installation cannot repair itself and an automation check on the exit
status would read the failed recovery as success.

The fix is in `cli/src/durable_tree.ts` (PR #333): `safeExtractTar` flushes every
file and directory of the extracted tree before the caller renames it and
switches the launcher.

## RC11 disposition: not verified in this evidence package

A prior draft named RC11 write and verify logs, but those log files are absent
from this evidence package. This package therefore makes no RC11 pass or failure
claim. The RC10 failure and fixed-CLI demonstration below are supported by their
included logs and remain distinct from RC11 qualification.

## Fix demonstration

`NEXUS_POWERLOSS_BASELINE_DIST` replaces the baseline CLI's `lib/cli/dist` with a
local build, so the same published artifacts are upgraded by a CLI that contains
the fix. `NEXUS_POWERLOSS_LOG_SUFFIX=fixed-cli` names the resulting logs, and the
guest records the SHA-256 of the dist's sorted file manifest in them (hashing only
`index.js` would not cover `durable_tree.js`, which carries the fix). With it, the identical cut leaves a
working launcher, recovery rolls back to rc.9, and a retry completes to rc.10
(`...-power-loss-durability-fixed-cli-{write,verify}.log`).

This demonstrates the fix; it is **not** release qualification. The cell can only
pass for a release whose own artifact contains the fix, i.e. a build after
PR #333.
