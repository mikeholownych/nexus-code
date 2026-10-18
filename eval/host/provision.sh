#!/usr/bin/env bash
# Provision the qualification host (eval/host/README.md). Run as root on the qualification host only:
#   sudo OPERATOR=<harness user> bash eval/host/provision.sh
# Idempotent. Touches only: the acl package, the nexus-eval system account and its home, one sudoers drop-in, one
# systemd mount unit for the tmpfs workspace root, and /opt/nexus-qual. Nothing else on the host is changed.
# Fail-closed on collisions: a pre-existing account, sudoers file, unit, runtime directory or mount that this procedure
# did not create stops the run unchanged. Everything it creates is recorded in a root-only ledger, and rollback.sh
# removes exactly the ledger's entries.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PROFILE="$HERE/resource-profile.json"
readonly ACCOUNT=nexus-eval
readonly ACCOUNT_HOME=/var/lib/nexus-eval
readonly SUDOERS=/etc/sudoers.d/90-nexus-eval
readonly RUNTIME=/opt/nexus-qual
readonly LEDGER_DIR=/var/lib/nexus-qual-host
readonly LEDGER="$LEDGER_DIR/ledger"
readonly MARKER="# Managed by nexus-code eval/host/provision.sh"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
: "${OPERATOR:?set OPERATOR to the account that runs eval/run.mjs}"
id -u "$OPERATOR" >/dev/null 2>&1 || { echo "operator $OPERATOR does not exist" >&2; exit 2; }
[[ "$OPERATOR" != "$ACCOUNT" && "$OPERATOR" != root ]] || { echo "operator must be a separate, non-root account" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required to read $PROFILE" >&2; exit 2; }
workspace_root=$(jq -er .workspaceRoot "$PROFILE")
storage_bytes=$(jq -er .storageBytes "$PROFILE")
[[ "$workspace_root" == /srv/* && "$storage_bytes" =~ ^[0-9]+$ ]] || { echo "unexpected profile values" >&2; exit 2; }
unit="$(systemd-escape -p --suffix=mount "$workspace_root")"
unit_file="/etc/systemd/system/$unit"
op_uid=$(id -u "$OPERATOR"); op_gid=$(id -g "$OPERATOR")

install -d -o root -g root -m 0700 "$LEDGER_DIR"
touch "$LEDGER"; chmod 0600 "$LEDGER"
owned() { grep -qxF "$1" "$LEDGER"; }
record() { owned "$1" || printf '%s\n' "$1" >> "$LEDGER"; }

# Collision checks first: nothing is changed unless every resource is absent or already recorded as ours.
problems=()
if id -u "$ACCOUNT" >/dev/null 2>&1 && ! owned "account $ACCOUNT"; then problems+=("account $ACCOUNT exists but was not created by this procedure"); fi
if [[ -e "$ACCOUNT_HOME" ]] && ! owned "home $ACCOUNT_HOME"; then problems+=("$ACCOUNT_HOME exists but was not created by this procedure"); fi
if [[ -e "$SUDOERS" ]] && ! { owned "sudoers $SUDOERS" && head -n 1 "$SUDOERS" | grep -qxF "$MARKER"; }; then problems+=("$SUDOERS exists and is not this procedure's"); fi
if [[ -e "$unit_file" ]] && ! { owned "unit $unit_file" && grep -qxF "$MARKER" "$unit_file"; }; then problems+=("$unit_file exists and is not this procedure's"); fi
if findmnt --mountpoint "$workspace_root" >/dev/null && ! owned "unit $unit_file"; then problems+=("$workspace_root is already a mount point not made by this procedure"); fi
if [[ -e "$workspace_root" ]] && ! owned "dir $workspace_root" && [[ -n "$(ls -A "$workspace_root" 2>/dev/null)" ]]; then problems+=("$workspace_root exists and is not empty"); fi
if [[ -e "$RUNTIME" ]] && ! owned "dir $RUNTIME"; then problems+=("$RUNTIME exists but was not created by this procedure"); fi
if ((${#problems[@]})); then printf 'refusing to provision (no changes made):\n' >&2; printf '  - %s\n' "${problems[@]}" >&2; exit 1; fi

# 1. setfacl, which the harness uses to grant the evaluator uid access to each disposable run directory.
if ! command -v setfacl >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends acl
  record "package acl"
fi

# 2. The evaluator account: a system user with no login shell and a private home it never needs for runs.
if ! id -u "$ACCOUNT" >/dev/null 2>&1; then
  useradd --system --home-dir "$ACCOUNT_HOME" --create-home --shell /usr/sbin/nologin "$ACCOUNT"
  record "account $ACCOUNT"
  record "home $ACCOUNT_HOME"
fi
chmod 0700 "$ACCOUNT_HOME"

# 3. The only privilege: the operator may run Bubblewrap as the evaluator account, without a password. The harness
#    invokes exactly `sudo -n -u nexus-eval -- /usr/bin/bwrap …` (eval/validate.mjs asUser).
tmp="$(mktemp)"
printf '%s\n%s ALL=(%s) NOPASSWD: /usr/bin/bwrap\n' "$MARKER" "$OPERATOR" "$ACCOUNT" > "$tmp"
visudo -cqf "$tmp"
install -o root -g root -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
record "sudoers $SUDOERS"
# The whole configuration must still parse; never leave a drop-in that breaks sudo.
visudo -cq || { rm -f "$SUDOERS"; echo "sudoers no longer parses with $SUDOERS; removed it" >&2; exit 1; }

# 4. The size-capped tmpfs workspace root, owned by the operator. Mode 0711 lets the evaluator traverse to the per-run
#    directories the harness creates (0700, random names, evaluator ACL) without listing the root; it persists across
#    remounts, unlike an ACL on the tmpfs root.
if [[ ! -e "$workspace_root" ]]; then mkdir -p "$workspace_root"; record "dir $workspace_root"; fi
cat > "$unit_file" <<EOF
$MARKER
[Unit]
Description=Nexus qualification workspace root (size-capped tmpfs)

[Mount]
What=tmpfs
Where=$workspace_root
Type=tmpfs
Options=size=$storage_bytes,mode=0711,uid=$op_uid,gid=$op_gid,nosuid,nodev

[Install]
WantedBy=local-fs.target
EOF
record "unit $unit_file"
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
# start, never restart: remounting a tmpfs would discard any run in progress.
systemctl start "$unit"
live="$(findmnt -n -b -o FSTYPE,SIZE --mountpoint "$workspace_root" | tr -s " ") $(stat -c '%u %a' "$workspace_root")"
[[ "$live" == "tmpfs $storage_bytes $op_uid 711" ]] || { echo "mounted $workspace_root is '$live', not 'tmpfs $storage_bytes $op_uid 711'; run rollback.sh, then provision again" >&2; exit 1; }

# 5. Root-owned, world-readable home for the installed RC and peer agents (sandboxRuntimeRoots); filled per RC.
if [[ ! -e "$RUNTIME" ]]; then install -d -o root -g root -m 0755 "$RUNTIME"; record "dir $RUNTIME"; fi

printf 'operator=%s\naccount=%s\nunit=%s\nprofile_sha256=%s\nat=%s\n' "$OPERATOR" "$ACCOUNT" "$unit" \
  "$(sha256sum "$PROFILE" | cut -d' ' -f1)" "$(date -u +%FT%TZ)" > "$LEDGER_DIR/state"
echo "provisioned: $ACCOUNT, $SUDOERS, $unit ($storage_bytes bytes), $RUNTIME; ledger $LEDGER"
