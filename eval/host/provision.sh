#!/usr/bin/env bash
# Provision the qualification host (eval/host/README.md). Run as root on the qualification host only:
#   sudo OPERATOR=<harness user> bash eval/host/provision.sh
# Idempotent. Touches only: the acl package, the nexus-eval system account and its home, one sudoers drop-in, one
# systemd mount unit for the tmpfs workspace root, and /opt/nexus-qual. Nothing else on the host is changed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PROFILE="$HERE/resource-profile.json"
readonly ACCOUNT=nexus-eval
readonly ACCOUNT_HOME=/var/lib/nexus-eval
readonly SUDOERS=/etc/sudoers.d/90-nexus-eval
readonly RUNTIME=/opt/nexus-qual
readonly STATE=/var/lib/nexus-qual-host.provisioned

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
: "${OPERATOR:?set OPERATOR to the account that runs eval/run.mjs}"
id -u "$OPERATOR" >/dev/null 2>&1 || { echo "operator $OPERATOR does not exist" >&2; exit 2; }
[[ "$OPERATOR" != "$ACCOUNT" && "$OPERATOR" != root ]] || { echo "operator must be a separate, non-root account" >&2; exit 2; }

workspace_root=$(jq -er .workspaceRoot "$PROFILE")
storage_bytes=$(jq -er .storageBytes "$PROFILE")
[[ "$workspace_root" == /srv/* && "$storage_bytes" =~ ^[0-9]+$ ]] || { echo "unexpected profile values" >&2; exit 2; }
unit="$(systemd-escape -p --suffix=mount "$workspace_root")"

# 1. setfacl, which the harness uses to grant the evaluator uid access to each disposable run directory.
command -v setfacl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends acl

# 2. The evaluator account: a system user with no login shell and a private home it never needs for runs.
if ! id -u "$ACCOUNT" >/dev/null 2>&1; then
  useradd --system --home-dir "$ACCOUNT_HOME" --create-home --shell /usr/sbin/nologin "$ACCOUNT"
fi
chmod 0700 "$ACCOUNT_HOME"

# 3. The only privilege: the operator may run Bubblewrap as the evaluator account, without a password.
tmp="$(mktemp)"
printf '# Managed by nexus-code eval/host/provision.sh\n%s ALL=(%s) NOPASSWD: /usr/bin/bwrap\n' "$OPERATOR" "$ACCOUNT" > "$tmp"
visudo -cqf "$tmp"
install -o root -g root -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
visudo -cq

# 4. The size-capped tmpfs workspace root, owned by the operator; per-run directories inside it get evaluator ACLs.
op_uid=$(id -u "$OPERATOR"); op_gid=$(id -g "$OPERATOR")
mkdir -p "$workspace_root"
cat > "/etc/systemd/system/$unit" <<EOF
# Managed by nexus-code eval/host/provision.sh
[Unit]
Description=Nexus qualification workspace root (size-capped tmpfs)

[Mount]
What=tmpfs
Where=$workspace_root
Type=tmpfs
Options=size=$storage_bytes,mode=0700,uid=$op_uid,gid=$op_gid,nosuid,nodev

[Install]
WantedBy=local-fs.target
EOF
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
# start, never restart: remounting a tmpfs would discard any run in progress.
systemctl start "$unit"
live=$(findmnt -n -b -o FSTYPE,SIZE --mountpoint "$workspace_root" | tr -s " ")
[[ "$live" == "tmpfs $storage_bytes" ]] || { echo "mounted $workspace_root is '$live', not 'tmpfs $storage_bytes'; run rollback.sh, then provision again" >&2; exit 1; }

# 5. Root-owned, world-readable home for the installed RC and peer agents (sandboxRuntimeRoots); filled per RC.
install -d -o root -g root -m 0755 "$RUNTIME"

printf 'operator=%s\naccount=%s\nunit=%s\nprofile_sha256=%s\nat=%s\n' "$OPERATOR" "$ACCOUNT" "$unit" \
  "$(sha256sum "$PROFILE" | cut -d' ' -f1)" "$(date -u +%FT%TZ)" > "$STATE"
echo "provisioned: $ACCOUNT, $SUDOERS, $unit ($storage_bytes bytes), $RUNTIME"
