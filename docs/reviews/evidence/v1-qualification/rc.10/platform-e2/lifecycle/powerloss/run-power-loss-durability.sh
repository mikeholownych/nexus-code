#!/usr/bin/env bash
# RC10 E2: true power-loss durability for an installed upgrade.
#
# Boots a minimal Linux guest from a fresh ext4 image with v1.0.0-rc.9 installed,
# starts an upgrade to v1.0.0-rc.10, and cuts power (SIGKILL of the VM) at the
# moment the durable journal reaches an in-flight state. A second boot then runs
# `nexus upgrade --recover` and proves the installation returns to rc.9 without
# torn state, and that a retry can complete the same upgrade.
#
# Requirements: qemu-system-x86_64 with KVM, a readable host kernel image,
# busybox, a Node.js >= 22 binary, and the published rc.9/rc.10 assets. Run as
# root (sudo -E) or as a user with read/write access to /dev/kvm; the harness must
# be able to signal QEMU directly so the power cut is a real SIGKILL.
#
# Assets layout (see fetch-assets.sh):
#   $ASSETS/rc.9/{nexus-linux-x86_64-v1.0.0-rc.9.tar.gz,SHA256SUMS,compatibility.json}
#   $ASSETS/rc.10/{nexus-linux-x86_64-v1.0.0-rc.10.tar.gz,SHA256SUMS,compatibility.json}
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
evidence="$(cd "$here/../.." && pwd)"
assets="${NEXUS_POWERLOSS_ASSETS:-/var/tmp/nexus-powerloss-assets}"
work="${NEXUS_POWERLOSS_WORK:-/var/tmp/nexus-powerloss-run}"
kernel="${NEXUS_POWERLOSS_KERNEL:-/boot/vmlinuz-$(uname -r)}"
node_bin="${NEXUS_POWERLOSS_NODE:-$(command -v node)}"
# Optional: replace the baseline CLI's dist with a local build to demonstrate a
# fix under test. Release qualification must leave this unset.
baseline_dist="${NEXUS_POWERLOSS_BASELINE_DIST:-}"
suffix="${NEXUS_POWERLOSS_LOG_SUFFIX:-}"
write_log="$evidence/ubuntu-22-04-node22-power-loss-durability${suffix:+-$suffix}-write.log"
verify_log="$evidence/ubuntu-22-04-node22-power-loss-durability${suffix:+-$suffix}-verify.log"

rc9_sha=35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb
rc10_sha=444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7

die() { echo "power-loss: $*" >&2; exit 1; }

# Serial console output carries CR bytes and trailing padding; normalize on copy.
normalize() { tr -d '\r' | sed 's/[[:space:]]*$//'; }

if [ "$(id -u)" -ne 0 ]; then
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not writable by $(id -un); rerun with sudo -E or grant access"
fi

for f in "$assets/rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz" \
         "$assets/rc.9/SHA256SUMS" "$assets/rc.9/compatibility.json" \
         "$assets/rc.10/nexus-linux-x86_64-v1.0.0-rc.10.tar.gz" \
         "$assets/rc.10/SHA256SUMS" "$assets/rc.10/compatibility.json"; do
  [ -f "$f" ] || die "missing asset $f (run fetch-assets.sh)"
done
[ "$(sha256sum "$assets/rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz" | awk '{print $1}')" = "$rc9_sha" ] || die "rc.9 archive digest mismatch"
[ "$(sha256sum "$assets/rc.10/nexus-linux-x86_64-v1.0.0-rc.10.tar.gz" | awk '{print $1}')" = "$rc10_sha" ] || die "rc.10 archive digest mismatch"
[ -f "$kernel" ] || die "missing kernel image $kernel"
[ -x "$node_bin" ] || die "missing node binary $node_bin"

[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not writable by $(id -un); run: sudo setfacl -m u:$(id -un):rw /dev/kvm"

rm -rf "$work"
mkdir -p "$work/initrd"/{bin,proc,sys,dev,tmp,mnt,opt/node/bin,usr/bin}
mkdir -p "$work/initrd/lib/x86_64-linux-gnu" "$work/initrd/lib64"

# Guest userland: busybox, flock (util-linux), Node and every shared library the
# packaged binaries and Node need.
cp /usr/bin/busybox "$work/initrd/bin/busybox"
cp /usr/bin/flock "$work/initrd/usr/bin/flock"
cp "$node_bin" "$work/initrd/opt/node/bin/node"
mkdir -p "$work/pkg"
tar -xzf "$assets/rc.10/nexus-linux-x86_64-v1.0.0-rc.10.tar.gz" -C "$work/pkg"
for bin in "$work/initrd/opt/node/bin/node" "$work/pkg/nexus/lib/core/harness-core" \
           "$work/pkg/nexus/lib/core/nexus-tui" "$work/initrd/usr/bin/flock"; do
  ldd "$bin" | awk '{print $3}' | grep '^/' || true
done | sort -u | while read -r lib; do
  mkdir -p "$work/initrd$(dirname "$lib")"
  cp -L "$lib" "$work/initrd$lib"
done
cp -L /lib64/ld-linux-x86-64.so.2 "$work/initrd/lib64/"
cp "$here/guest-init" "$work/initrd/init"
chmod +x "$work/initrd/init"
(cd "$work/initrd" && find . | cpio -o -H newc 2>/dev/null | gzip -9 > "$work/initrd.gz")

# Fresh disk with only rc.9 installed.
truncate -s 2G "$work/disk.img"
mkfs.ext4 -q -F "$work/disk.img"
mkdir -p "$work/mnt"
sudo mount -o loop "$work/disk.img" "$work/mnt"
sudo chown -R "$(id -u):$(id -g)" "$work/mnt"
mkdir -p "$work/mnt/home/.local/lib/nexus" "$work/mnt/home/.local/bin" "$work/mnt/home/.nexus/tasks"
tar -xzf "$assets/rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz" -C "$work/mnt/home/.local/lib/nexus"
mv "$work/mnt/home/.local/lib/nexus/nexus" "$work/mnt/home/.local/lib/nexus/v1.0.0-rc.9"
dist_sha=""
if [ -n "$baseline_dist" ]; then
  [ -f "$baseline_dist/index.js" ] || die "baseline dist not found at $baseline_dist"
  # Hash the whole dist (sorted file manifest), not just the entry point: the fix
  # lives in durable_tree.js, which index.js imports dynamically.
  dist_sha=$(cd "$baseline_dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
  rm -rf "$work/mnt/home/.local/lib/nexus/v1.0.0-rc.9/lib/cli/dist"
  cp -a "$baseline_dist" "$work/mnt/home/.local/lib/nexus/v1.0.0-rc.9/lib/cli/dist"
fi
ln -sfn ../lib/nexus/v1.0.0-rc.9/bin/nexus "$work/mnt/home/.local/bin/nexus"
printf 'baseline rc.9\n' > "$work/mnt/home/.nexus/tasks/marker"
sudo umount "$work/mnt"

# Fixture server for the rc.10 assets.
node "$here/serve-release.cjs" "$assets/rc.10" 18080 > "$work/serve.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q serving "$work/serve.log" 2>/dev/null && break; sleep 0.1; done
grep -q serving "$work/serve.log" || die "fixture server did not start"
port=$(sed -n 's/.*port=\([0-9]*\).*/\1/p' "$work/serve.log" | head -1)
[ "$port" = 18080 ] || die "fixture server bound $port, expected 18080 (guest slirp maps 10.0.2.2)"

boot() {
  local phase=$1 out=$2
  exec qemu-system-x86_64 -enable-kvm -cpu host -m 2048 -smp 2 \
    -kernel "$kernel" -initrd "$work/initrd.gz" \
    -append "console=ttyS0 phase=$phase panic=-1 fixedcli=${dist_sha:-none}" \
    -nographic -no-reboot \
    -drive "file=$work/disk.img,format=raw,if=virtio,cache=none" \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 > "$out" 2>&1
}

# Write phase: cut power as soon as the durable journal reports a switching
# transaction. SIGKILL of the VM is the power cut; nothing is synced first.
boot write "$work/write.log" &
qemu_pid=$!
cut=0
for _ in $(seq 1 1800); do
  if grep -q 'POWERLOSS_CUT=now' "$work/write.log" 2>/dev/null; then cut=1; break; fi
  grep -q 'POWERLOSS_TIMEOUT\|POWERLOSS_BASELINE_UNEXPECTED\|POWERLOSS_UNEXPECTED' "$work/write.log" 2>/dev/null && break
  kill -0 "$qemu_pid" 2>/dev/null || break
  sleep 0.1
done
kill -9 "$qemu_pid" 2>/dev/null || true
wait "$qemu_pid" 2>/dev/null || true
# The image lock is released when QEMU dies; give the kernel a moment.
for _ in $(seq 1 50); do qemu-img check "$work/disk.img" >/dev/null 2>&1 && break; sleep 0.1; done
[ "$cut" = 1 ] || { normalize < "$work/write.log" > "$write_log"; die "no power cut occurred; see $write_log"; }

# Verify phase: recovery must restore rc.9, be idempotent, and allow a retry.
boot verify "$work/verify.log" &
verify_pid=$!
for _ in $(seq 1 6000); do kill -0 "$verify_pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$verify_pid" 2>/dev/null; then
  kill -9 "$verify_pid" 2>/dev/null || true
  normalize < "$work/write.log" > "$write_log"; normalize < "$work/verify.log" > "$verify_log" 2>/dev/null || true
  die "verify boot timed out"
fi
wait "$verify_pid" || { normalize < "$work/write.log" > "$write_log"; normalize < "$work/verify.log" > "$verify_log" 2>/dev/null || true; die "verify boot failed"; }

normalize < "$work/write.log" > "$write_log"
normalize < "$work/verify.log" > "$verify_log"

grep -q 'POWERLOSS_VERIFY=PASS' "$verify_log" || die "verification did not pass; see $verify_log"
grep -q 'journal_rolled_back=true' "$verify_log" || die "recovery did not roll back"
grep -q 'retry_completed=true' "$verify_log" || die "retry did not complete"
grep -q 'marker_retained=true' "$verify_log" || die "user state was lost"
echo "power_loss_durability=PASS journal_recovered=true rolled_back_to_rc9=true retry_completed_rc10=true user_state_retained=true"
