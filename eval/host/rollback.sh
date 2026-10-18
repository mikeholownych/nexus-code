#!/usr/bin/env bash
# Undo eval/host/provision.sh. Run as root: sudo bash eval/host/rollback.sh [--purge-runtime]
# Removes only what provision.sh recorded in its ledger as created by it; anything that pre-existed is never touched.
# /opt/nexus-qual (installed RC and peer agents) is kept unless --purge-runtime is given. A package that provision
# installed (acl) is left installed. Run outputs elsewhere are kept.
set -euo pipefail

readonly ACCOUNT=nexus-eval
readonly LEDGER_DIR=/var/lib/nexus-qual-host
readonly LEDGER="$LEDGER_DIR/ledger"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
[[ -f "$LEDGER" ]] || { echo "no provisioning ledger at $LEDGER; nothing was created by provision.sh" >&2; exit 1; }
owned() { grep -qxF "$1" "$LEDGER"; }
entries() { sed -n "s/^$1 //p" "$LEDGER"; }

if owned "account $ACCOUNT" && pgrep -u "$ACCOUNT" >/dev/null 2>&1; then echo "processes still run as $ACCOUNT; stop the evaluation first" >&2; exit 1; fi

# The mount must come down before anything else is removed, so an abort leaves the host as provisioned.
for unit_file in $(entries unit); do
  unit="$(basename "$unit_file")"
  where="$(sed -n 's/^Where=//p' "$unit_file" 2>/dev/null || true)"
  systemctl disable --now "$unit" 2>/dev/null || true
  if [[ -n "$where" ]] && findmnt --mountpoint "$where" >/dev/null; then echo "$where is still mounted (busy?); nothing removed" >&2; exit 1; fi
done
for unit_file in $(entries unit); do rm -f "$unit_file"; done
systemctl daemon-reload
for sudoers in $(entries sudoers); do rm -f "$sudoers"; done
visudo -cq
if owned "account $ACCOUNT"; then
  if owned "home /var/lib/nexus-eval"; then userdel --remove "$ACCOUNT"; else userdel "$ACCOUNT"; fi
fi
for dir in $(entries dir); do
  if [[ "$dir" == /opt/nexus-qual ]]; then [[ "${1:-}" == --purge-runtime ]] && rm -rf "$dir"; continue; fi
  rmdir "$dir" 2>/dev/null || echo "left non-empty $dir" >&2
done
if [[ "${1:-}" == --purge-runtime || ! -e /opt/nexus-qual ]]; then rm -rf "$LEDGER_DIR"; else grep -xF "dir /opt/nexus-qual" "$LEDGER" > "$LEDGER.keep" || true; mv "$LEDGER.keep" "$LEDGER"; fi
echo "rolled back qualification host provisioning"
