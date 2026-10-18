#!/bin/bash
# Exercises provision.sh and rollback.sh as root in a disposable privileged container (no host changes):
#   docker run --rm --privileged -v "$PWD":/t:ro ubuntu:24.04 bash /t/eval/host/container-test/run.sh
# Every line must read PASS. systemctl is a shim that mounts and unmounts the unit's tmpfs.
set -u
apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq sudo systemd util-linux >/dev/null 2>&1
cp /t/eval/host/container-test/systemctl-shim /usr/local/bin/systemctl
useradd -m mike
P="env OPERATOR=mike bash /t/eval/host/provision.sh"; R="bash /t/eval/host/rollback.sh"
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; }
state() { echo "  sudoers=$( [ -e /etc/sudoers.d/90-nexus-eval ] && echo y || echo n) unit=$( ls /etc/systemd/system/*.mount 2>/dev/null | wc -l) acct=$(id -u nexus-eval 2>/dev/null || echo none) mount=$(findmnt -n -o FSTYPE --mountpoint /srv/nexus-qual/ws || echo none) ledger=$(tr '\n' '|' < /var/lib/nexus-qual-host/ledger 2>/dev/null)"; }
# 1 fresh + idempotent
$P >/tmp/o 2>&1 && ok "1a fresh provision" || { bad "1a"; cat /tmp/o; }
[[ "$(stat -c %a /var/lib/nexus-qual-host/ledger)" == 600 ]] && ok "1b ledger 0600" || bad "1b ledger mode $(stat -c %a /var/lib/nexus-qual-host/ledger)"
grep -q "^account nexus-eval uid=$(id -u nexus-eval) home=/var/lib/nexus-eval$" /var/lib/nexus-qual-host/ledger && ok "1c account uid recorded" || bad "1c"
! grep -q '^pending' /var/lib/nexus-qual-host/ledger && ok "1d no pending left" || bad "1d"
$P >/tmp/o 2>&1 && ok "1e idempotent re-run" || { bad "1e"; cat /tmp/o; }
state
# 2 rollback
$R >/tmp/o 2>&1 && ok "2a rollback" || { bad "2a"; cat /tmp/o; }
[[ ! -e /etc/sudoers.d/90-nexus-eval && -z "$(ls /etc/systemd/system/*.mount 2>/dev/null)" ]] && ! id nexus-eval >/dev/null 2>&1 && ! findmnt --mountpoint /srv/nexus-qual/ws >/dev/null && ok "2b all removed" || { bad "2b"; state; }
[[ -d /opt/nexus-qual ]] && ok "2c runtime kept without --purge-runtime" || bad "2c"
$R --purge-runtime >/tmp/o 2>&1; $P >/tmp/o 2>&1 && $R --purge-runtime >/tmp/o 2>&1 && [[ ! -e /opt/nexus-qual && ! -e /var/lib/nexus-qual-host/ledger ]] && ok "2d purge removes runtime and ledger" || { bad "2d"; cat /tmp/o; }
# 3 foreign account
useradd --system nexus-eval; $P >/tmp/o 2>&1 && bad "3a provision accepted a foreign account" || ok "3a refused foreign account"
[[ ! -e /etc/sudoers.d/90-nexus-eval && -z "$(ls /etc/systemd/system/*.mount 2>/dev/null)" ]] && ok "3b no changes on refusal" || { bad "3b"; state; }
$R >/tmp/o 2>&1; id nexus-eval >/dev/null 2>&1 && ok "3c rollback left foreign account" || bad "3c rollback deleted a foreign account"
userdel nexus-eval
# 4 foreign sudoers
echo "mike ALL=(ALL) ALL" > /etc/sudoers.d/90-nexus-eval; chmod 440 /etc/sudoers.d/90-nexus-eval
$P >/tmp/o 2>&1 && bad "4a accepted foreign sudoers" || ok "4a refused foreign sudoers"
! id nexus-eval >/dev/null 2>&1 && ok "4b no account created on refusal" || bad "4b"
rm /etc/sudoers.d/90-nexus-eval; rm -rf /var/lib/nexus-qual-host
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
