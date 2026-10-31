#!/bin/bash
# Exercises provision.sh and rollback.sh as root in a disposable privileged container (no host changes):
#   docker run --rm --privileged -v "$PWD":/t:ro ubuntu:24.04 bash /t/eval/host/container-test/run.sh
# Every line must read PASS. systemctl is a shim that mounts and unmounts the unit's tmpfs.
set -u
apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq sudo systemd util-linux >/dev/null 2>&1
cp /t/eval/host/container-test/systemctl-shim /usr/local/bin/systemctl
useradd -m mike
P="env OPERATOR=mike bash /t/eval/host/provision.sh"; R="bash /t/eval/host/rollback.sh"
fails=0
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails + 1)); }
state() { echo "  sudoers=$( [ -e /etc/sudoers.d/99-nexus-eval ] && echo y || echo n) unit=$( ls /etc/systemd/system/*.mount 2>/dev/null | wc -l) acct=$(id -u nexus-eval 2>/dev/null || echo none) mount=$(findmnt -n -o FSTYPE --mountpoint /srv/nexus-qual/ws || echo none) ledger=$(tr '\n' '|' < /var/lib/nexus-qual-host/ledger 2>/dev/null)"; }
# 1 fresh + idempotent
$P >/tmp/o 2>&1 && ok "1a fresh provision" || { bad "1a"; cat /tmp/o; }
[[ "$(stat -c %a /var/lib/nexus-qual-host/ledger)" == 600 ]] && ok "1b ledger 0600" || bad "1b ledger mode $(stat -c %a /var/lib/nexus-qual-host/ledger)"
grep -q "^account nexus-eval uid=$(id -u nexus-eval) home=/var/lib/nexus-eval$" /var/lib/nexus-qual-host/ledger && ok "1c account uid recorded" || bad "1c"
! grep -q '^pending' /var/lib/nexus-qual-host/ledger && ok "1d no pending left" || bad "1d"
$P >/tmp/o 2>&1 && ok "1e idempotent re-run" || { bad "1e"; cat /tmp/o; }
state
# 2 rollback
$R >/tmp/o 2>&1 && ok "2a rollback" || { bad "2a"; cat /tmp/o; }
[[ ! -e /etc/sudoers.d/99-nexus-eval && -z "$(ls /etc/systemd/system/*.mount 2>/dev/null)" ]] && ! id nexus-eval >/dev/null 2>&1 && ! findmnt --mountpoint /srv/nexus-qual/ws >/dev/null && ok "2b all removed" || { bad "2b"; state; }
[[ -d /opt/nexus-qual ]] && ok "2c runtime kept without --purge-runtime" || bad "2c"
$R --purge-runtime >/tmp/o 2>&1; $P >/tmp/o 2>&1 && $R --purge-runtime >/tmp/o 2>&1 && [[ ! -e /opt/nexus-qual && ! -e /var/lib/nexus-qual-host/ledger ]] && ok "2d purge removes runtime and ledger" || { bad "2d"; cat /tmp/o; }
# 3 foreign account
useradd --system nexus-eval; $P >/tmp/o 2>&1 && bad "3a provision accepted a foreign account" || ok "3a refused foreign account"
[[ ! -e /etc/sudoers.d/99-nexus-eval && -z "$(ls /etc/systemd/system/*.mount 2>/dev/null)" ]] && ok "3b no changes on refusal" || { bad "3b"; state; }
$R >/tmp/o 2>&1; id nexus-eval >/dev/null 2>&1 && ok "3c rollback left foreign account" || bad "3c rollback deleted a foreign account"
userdel nexus-eval
# 4 foreign sudoers
echo "mike ALL=(ALL) ALL" > /etc/sudoers.d/99-nexus-eval; chmod 440 /etc/sudoers.d/99-nexus-eval
$P >/tmp/o 2>&1 && bad "4a accepted foreign sudoers" || ok "4a refused foreign sudoers"
! id nexus-eval >/dev/null 2>&1 && ok "4b no account created on refusal" || bad "4b"
rm /etc/sudoers.d/99-nexus-eval; rm -rf /var/lib/nexus-qual-host
# 5 symlinked root
mkdir -p /srv /elsewhere/ws; ln -s /elsewhere /srv/nexus-qual
$P >/tmp/o 2>&1 && bad "5 accepted symlinked root" || ok "5 refused symlinked workspace root"
rm /srv/nexus-qual; rm -rf /elsewhere /var/lib/nexus-qual-host
# 6 crash recovery: account created, ledger only has pending
$P >/tmp/o 2>&1; sed -i "s/^account nexus-eval uid=.*/pending account nexus-eval/" /var/lib/nexus-qual-host/ledger
$P >/tmp/o 2>&1 && grep -q "^account nexus-eval uid=" /var/lib/nexus-qual-host/ledger && ok "6 resumed after interrupted account creation" || { bad "6"; cat /tmp/o; }
# 7 stale ledger: account recreated with another uid
umount /srv/nexus-qual/ws 2>/dev/null; userdel -r nexus-eval; useradd --system --uid 990 -d /var/lib/nexus-eval -s /usr/sbin/nologin nexus-eval
$R >/tmp/o 2>&1; id nexus-eval >/dev/null 2>&1 && ok "7 rollback left a re-created account (uid changed)" || bad "7 rollback deleted a re-created account"
# 8 stale pending runtime dir is neither adopted nor purged
userdel -r nexus-eval 2>/dev/null; rm -rf /var/lib/nexus-qual-host /opt/nexus-qual /srv/nexus-qual /etc/sudoers.d/99-nexus-eval /etc/systemd/system/*.mount
install -d -m 0700 /var/lib/nexus-qual-host; printf 'pending dir /opt/nexus-qual\n' > /var/lib/nexus-qual-host/ledger; chmod 600 /var/lib/nexus-qual-host/ledger
mkdir -p /opt/nexus-qual && echo data > /opt/nexus-qual/operator-file
$P >/tmp/o 2>&1 && bad "8a adopted a stale-pending runtime dir" || ok "8a refused a runtime dir created after an interrupted run"
$R --purge-runtime >/tmp/o 2>&1; [[ -f /opt/nexus-qual/operator-file ]] && ok "8b purge left the operator's runtime dir" || bad "8b purge deleted the operator's runtime dir"
rm -rf /opt/nexus-qual /var/lib/nexus-qual-host
# 9 dangling symlink at the sudoers path
ln -s /tmp/elsewhere-sudoers /etc/sudoers.d/99-nexus-eval
$P >/tmp/o 2>&1 && bad "9a wrote through a dangling sudoers symlink" || ok "9a refused a dangling sudoers symlink"
[[ ! -e /tmp/elsewhere-sudoers ]] && ok "9b nothing written through the link" || bad "9b"
rm -f /etc/sudoers.d/99-nexus-eval; rm -rf /var/lib/nexus-qual-host
# 10 a sudoers file edited after provisioning survives rollback
$P >/tmp/o 2>&1 || { bad "10 provision"; cat /tmp/o; }
echo "# operator note" >> /etc/sudoers.d/99-nexus-eval
$R >/tmp/o 2>&1; [[ -f /etc/sudoers.d/99-nexus-eval ]] && ok "10 rollback left a sudoers file whose content changed" || bad "10 rollback deleted an edited sudoers file"
rm -f /etc/sudoers.d/99-nexus-eval
# 11 a directory rollback could not remove stays recorded
userdel -r nexus-eval 2>/dev/null; rm -rf /var/lib/nexus-qual-host /opt/nexus-qual /srv/nexus-qual /etc/systemd/system/*.mount
$P >/tmp/o 2>&1 || { bad "11 provision"; cat /tmp/o; }
umount /srv/nexus-qual/ws; touch /srv/nexus-qual/ws/leftover; mount -t tmpfs tmpfs /srv/nexus-qual/ws -o size=1m 2>/dev/null; umount /srv/nexus-qual/ws
$R >/tmp/o 2>&1; grep -qxF "dir /srv/nexus-qual/ws" /var/lib/nexus-qual-host/ledger 2>/dev/null && ok "11 non-empty directory kept in the ledger" || bad "11 ledger forgot a directory it could not remove"
exit $((fails > 0 ? 1 : 0))
