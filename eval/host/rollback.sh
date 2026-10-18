#!/usr/bin/env bash
# Undo eval/host/provision.sh. Run as root: sudo bash eval/host/rollback.sh [--purge-runtime]
# Removes only resources that the ledger names AND that still verifiably belong to this procedure: the account only if
# its uid and home match what was recorded, files only if they carry the procedure's marker, and only the exact paths
# provision.sh computes. Anything else (pre-existing, re-created by someone else, or a tampered ledger entry) is left.
# /opt/nexus-qual (installed RC and peer agents) is kept unless --purge-runtime is given. A package provision installed
# (acl) is left installed. Run outputs elsewhere are kept.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly ACCOUNT=nexus-eval
readonly ACCOUNT_HOME=/var/lib/nexus-eval
readonly SUDOERS=/etc/sudoers.d/90-nexus-eval
readonly RUNTIME=/opt/nexus-qual
readonly LEDGER_DIR=/var/lib/nexus-qual-host
readonly LEDGER="$LEDGER_DIR/ledger"
readonly MARKER="# Managed by nexus-code eval/host/provision.sh"
readonly RUNTIME_MARKER="$RUNTIME/.nexus-qual-managed"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
[[ -f "$LEDGER" ]] || { echo "no provisioning ledger at $LEDGER; nothing was created by provision.sh" >&2; exit 1; }
exec 9>"$LEDGER_DIR/lock"
flock -n 9 || { echo "another provision or rollback is running" >&2; exit 1; }

workspace_root=$(jq -er .workspaceRoot "$HERE/resource-profile.json")
workspace_parent="$(dirname "$workspace_root")"
unit="$(systemd-escape -p --suffix=mount "$workspace_root")"
unit_file="/etc/systemd/system/$unit"
has() { grep -qxF "$1" "$LEDGER"; }   # confirmed entries only
# A file is removed only if it is a regular marked file whose content still matches the recorded digest.
ours_file() {
  [[ -f "$1" && ! -L "$1" ]] && head -n 1 "$1" | grep -qxF "$MARKER" || return 1
  has "file $1 sha256=$(sha256sum "$1" | cut -d' ' -f1)"
}

if id -u "$ACCOUNT" >/dev/null 2>&1 && pgrep -u "$ACCOUNT" >/dev/null 2>&1; then echo "processes still run as $ACCOUNT; stop the evaluation first" >&2; exit 1; fi

# The mount comes down first, so an abort leaves everything else as provisioned.
if ours_file "$unit_file"; then
  systemctl disable --now "$unit" 2>/dev/null || true
  if findmnt --mountpoint "$workspace_root" >/dev/null; then echo "$workspace_root is still mounted (busy?); nothing removed" >&2; exit 1; fi
  rm -f "$unit_file"
  systemctl daemon-reload
fi
if ours_file "$SUDOERS"; then rm -f "$SUDOERS"; fi
visudo -cq

# The account only if it is still the one this procedure created (same uid and home as recorded).
recorded="$(grep -E "^account $ACCOUNT uid=[0-9]+ home=" "$LEDGER" | tail -n 1 || true)"
if [[ -n "$recorded" ]] && id -u "$ACCOUNT" >/dev/null 2>&1; then
  if [[ "$recorded" == "account $ACCOUNT uid=$(id -u "$ACCOUNT") home=$ACCOUNT_HOME" && "$(getent passwd "$ACCOUNT" | cut -d: -f6)" == "$ACCOUNT_HOME" ]]; then
    userdel --remove "$ACCOUNT"
  else
    echo "account $ACCOUNT no longer matches the ledger ($recorded); left in place" >&2
  fi
fi

# Directories: only the exact paths provision.sh creates, children before parents, and only when empty.
kept=()
for dir in "$workspace_root" "$workspace_parent"; do
  if has "dir $dir" && [[ -d "$dir" && ! -L "$dir" ]]; then rmdir "$dir" 2>/dev/null || { echo "left non-empty $dir" >&2; kept+=("dir $dir"); }; fi
done
# The runtime is purged only if confirmed in the ledger and still carrying the procedure's marker file.
if has "dir $RUNTIME" && [[ -d "$RUNTIME" && ! -L "$RUNTIME" ]]; then
  if [[ "${1:-}" == --purge-runtime && -f "$RUNTIME_MARKER" ]]; then rm -rf --one-file-system "$RUNTIME"; else kept+=("dir $RUNTIME"); fi
fi
if ((${#kept[@]})); then printf '%s\n' "${kept[@]}" > "$LEDGER"; chmod 0600 "$LEDGER"; else rm -rf "$LEDGER_DIR"; fi
echo "rolled back qualification host provisioning"
