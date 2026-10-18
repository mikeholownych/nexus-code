#!/usr/bin/env bash
# Undo eval/host/provision.sh. Run as root: sudo bash eval/host/rollback.sh [--purge-runtime]
# Removes the mount unit, the sudoers drop-in and the nexus-eval account. /opt/nexus-qual (installed RC and peer
# agents) is kept unless --purge-runtime is given. The acl package is left installed. Run outputs elsewhere are kept.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly ACCOUNT=nexus-eval
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }

workspace_root=$(jq -er .workspaceRoot "$HERE/resource-profile.json")
unit="$(systemd-escape -p --suffix=mount "$workspace_root")"

if pgrep -u "$ACCOUNT" >/dev/null 2>&1; then echo "processes still run as $ACCOUNT; stop the evaluation first" >&2; exit 1; fi
systemctl disable --now "$unit" 2>/dev/null || true
rm -f "/etc/systemd/system/$unit"
systemctl daemon-reload
rmdir "$workspace_root" 2>/dev/null || true
rm -f /etc/sudoers.d/90-nexus-eval
visudo -cq
if id -u "$ACCOUNT" >/dev/null 2>&1; then userdel --remove "$ACCOUNT"; fi
[[ "${1:-}" == --purge-runtime ]] && rm -rf /opt/nexus-qual
rm -f /var/lib/nexus-qual-host.provisioned
echo "rolled back qualification host provisioning"
