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
#   $ASSETS/<base-tag>/{nexus-linux-x86_64-<base-tag>.tar.gz,SHA256SUMS,compatibility.json}
#   $ASSETS/<target-tag>/{nexus-linux-x86_64-<target-tag>.tar.gz,SHA256SUMS,compatibility.json}
# Tags and archive digests are pinned below; override for another candidate. The
# published pins in git history are rc.9 -> rc.10 and rc.10 -> rc.11.
set -euo pipefail

die() { echo "power-loss: $*" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
evidence="$(cd "$here/../.." && pwd)"
assets="${NEXUS_POWERLOSS_ASSETS:-/var/tmp/nexus-powerloss-assets}"
work="${NEXUS_POWERLOSS_WORK:-}"
work_parent=""
work_default=0
if [ -z "$work" ]; then
  work_parent=/var/tmp
  work_default=1
else
  case "$work" in
    /*) ;;
    *) die "NEXUS_POWERLOSS_WORK must be an absolute path" ;;
  esac
  work_parent="${work%/*}"
  work_name="${work##*/}"
  [ -n "$work_name" ] && [ "$work_name" != . ] && [ "$work_name" != .. ] || die "NEXUS_POWERLOSS_WORK must name a directory, not its parent"
  [ -d "$work_parent" ] || die "NEXUS_POWERLOSS_WORK parent does not exist: $work_parent"
  canonical_parent="$(cd -- "$work_parent" && pwd -P)" || die "cannot resolve NEXUS_POWERLOSS_WORK parent"
  [ "$canonical_parent" = "$work_parent" ] || die "NEXUS_POWERLOSS_WORK parent must not contain symlinks or dot segments"
  work_parent="$canonical_parent"
  if [ "$work_parent" = /var/tmp ]; then
    [ "$(stat -c '%a' -- "$work_parent")" = 1777 ] || die "/var/tmp must be mode 1777 for a caller-selected work directory"
  else
    expected_owner="${SUDO_UID:-$(id -u)}"
    [ "$(stat -c '%u' -- "$work_parent")" = "$expected_owner" ] || die "NEXUS_POWERLOSS_WORK parent must be owned by uid $expected_owner"
    [ "$(stat -c '%a' -- "$work_parent")" = 700 ] || die "NEXUS_POWERLOSS_WORK parent must be private mode 700"
  fi
  { [ ! -e "$work" ] && [ ! -L "$work" ]; } || die "refusing to reuse existing NEXUS_POWERLOSS_WORK path: $work"
fi
kernel="${NEXUS_POWERLOSS_KERNEL:-/boot/vmlinuz-$(uname -r)}"
node_bin="${NEXUS_POWERLOSS_NODE:-$(command -v node)}"
# Optional: replace the baseline CLI's dist with a local build to demonstrate a
# fix under test. Release qualification must leave this unset.
baseline_dist="${NEXUS_POWERLOSS_BASELINE_DIST:-}"
suffix="${NEXUS_POWERLOSS_LOG_SUFFIX:-}"
if [ -n "$suffix" ]; then
  [[ "$suffix" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "NEXUS_POWERLOSS_LOG_SUFFIX must be a safe filename component"
  case "$suffix" in *..*) die "NEXUS_POWERLOSS_LOG_SUFFIX must not contain '..'" ;; esac
fi
write_log="$evidence/ubuntu-22-04-node22-power-loss-durability${suffix:+-$suffix}-write.log"
verify_log="$evidence/ubuntu-22-04-node22-power-loss-durability${suffix:+-$suffix}-verify.log"

base_tag="${NEXUS_POWERLOSS_BASE_TAG:-v1.0.0-rc.9}"
base_sha="${NEXUS_POWERLOSS_BASE_SHA:-35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb}"
target_tag="${NEXUS_POWERLOSS_TARGET_TAG:-v1.0.0-rc.10}"
target_sha="${NEXUS_POWERLOSS_TARGET_SHA:-444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7}"

# These values become directory and filename components below. Accept only
# semantic-version release tags and a bounded log basename suffix.
tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$base_tag" =~ $tag_pattern ]] || die "invalid NEXUS_POWERLOSS_BASE_TAG: expected a v-prefixed semantic version"
[[ "$target_tag" =~ $tag_pattern ]] || die "invalid NEXUS_POWERLOSS_TARGET_TAG: expected a v-prefixed semantic version"

# Serial console output carries CR bytes and trailing padding; normalize on copy.
normalize() { tr -d '\r\000' | sed 's/[[:space:]]*$//'; }

if [ "$(id -u)" -ne 0 ]; then
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not writable by $(id -un); rerun with sudo -E or grant access"
fi

for tag in "$base_tag" "$target_tag"; do
  for f in "$assets/$tag/nexus-linux-x86_64-$tag.tar.gz" "$assets/$tag/SHA256SUMS" "$assets/$tag/compatibility.json"; do
    [ -f "$f" ] || die "missing asset $f (run fetch-assets.sh)"
  done
done
[ "$(sha256sum "$assets/$base_tag/nexus-linux-x86_64-$base_tag.tar.gz" | awk '{print $1}')" = "$base_sha" ] || die "$base_tag archive digest mismatch"
[ "$(sha256sum "$assets/$target_tag/nexus-linux-x86_64-$target_tag.tar.gz" | awk '{print $1}')" = "$target_sha" ] || die "$target_tag archive digest mismatch"
[ -f "$kernel" ] || die "missing kernel image $kernel"
[ -x "$node_bin" ] || die "missing node binary $node_bin"

[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not writable by $(id -un); run: sudo setfacl -m u:$(id -un):rw /dev/kvm"

# Never recursively delete a caller-selected path from a privileged harness.
# The default is a fresh private directory; an explicit path must be new and
# have a validated parent (either sticky /var/tmp or a private owner directory).
umask 077
if [ "$work_default" -eq 1 ]; then
  work="$(mktemp -d /var/tmp/nexus-powerloss-run.XXXXXX)" || die "cannot create private work directory under /var/tmp"
else
  mkdir -m 700 -- "$work" || die "cannot create private work directory: $work"
fi
[ -d "$work" ] && [ ! -L "$work" ] || die "work directory is not a real directory"
[ "$(stat -c '%a' -- "$work")" = 700 ] || die "work directory is not mode 700"
echo "power-loss: private work directory $work"
mkdir -p "$work/initrd"/{bin,proc,sys,dev,tmp,mnt,opt/node/bin,usr/bin}
mkdir -p "$work/initrd/lib/x86_64-linux-gnu" "$work/initrd/lib64"

# Guest userland: busybox, flock (util-linux), Node and every shared library the
# packaged binaries and Node need.
cp /usr/bin/busybox "$work/initrd/bin/busybox"
cp /usr/bin/flock "$work/initrd/usr/bin/flock"
cp "$node_bin" "$work/initrd/opt/node/bin/node"
mkdir -p "$work/pkg"
tar -xzf "$assets/$target_tag/nexus-linux-x86_64-$target_tag.tar.gz" -C "$work/pkg"
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
tar -xzf "$assets/$base_tag/nexus-linux-x86_64-$base_tag.tar.gz" -C "$work/mnt/home/.local/lib/nexus"
mv "$work/mnt/home/.local/lib/nexus/nexus" "$work/mnt/home/.local/lib/nexus/$base_tag"
dist_sha=""
if [ -n "$baseline_dist" ]; then
  [ -f "$baseline_dist/index.js" ] || die "baseline dist not found at $baseline_dist"
  # Hash the whole dist (sorted file manifest), not just the entry point: the fix
  # lives in durable_tree.js, which index.js imports dynamically.
  dist_sha=$(cd "$baseline_dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
  mount_root="$(realpath -e -- "$work/mnt")" || die "cannot resolve mounted image root"
  dist_target="$work/mnt/home/.local/lib/nexus/$base_tag/lib/cli/dist"
  resolved_parent="$(realpath -e -- "$(dirname -- "$dist_target")")" || die "cannot resolve baseline dist parent"
  case "$resolved_parent" in
    "$mount_root"/*) ;;
    *) die "baseline dist parent resolves outside mounted image: $resolved_parent" ;;
  esac
  [ -d "$dist_target" ] && [ ! -L "$dist_target" ] || die "baseline dist target must be a real directory inside the mounted image"
  rm -rf -- "$dist_target"
  cp -a "$baseline_dist" "$work/mnt/home/.local/lib/nexus/$base_tag/lib/cli/dist"
fi
ln -sfn "../lib/nexus/$base_tag/bin/nexus" "$work/mnt/home/.local/bin/nexus"
printf 'baseline %s\n' "$base_tag" > "$work/mnt/home/.nexus/tasks/marker"
sudo umount "$work/mnt"

# Fixture server for the rc.10 assets.
node "$here/serve-release.cjs" "$assets/$target_tag" 18080 > "$work/serve.log" 2>&1 &
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
    -append "console=ttyS0 phase=$phase panic=-1 fixedcli=${dist_sha:-none} basever=$base_tag targetver=$target_tag" \
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
echo "power_loss_durability=PASS journal_recovered=true rolled_back_to=$base_tag retry_completed=$target_tag user_state_retained=true"
