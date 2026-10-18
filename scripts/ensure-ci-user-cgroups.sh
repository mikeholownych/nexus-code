#!/usr/bin/env bash
set -euo pipefail

# The evaluator resource contract (eval/resources.mjs) runs each task-controlled
# command in a delegated transient systemd --user scope with the cpu, memory and
# pids cgroup v2 controllers. Hosted runners have no user manager for the runner
# account, and older systemd delegates only some controllers to user@.service.
# Provision both, then prove a delegated scope sees all three controllers.

uid="$(id -u)"
runtime="/run/user/$uid"

has_contract() {
  XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" \
    systemd-run --user --scope --quiet --collect -p Delegate=yes -- \
    /bin/sh -c 'c=$(cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/cgroup.controllers"); for k in cpu memory pids; do case " $c " in *" $k "*) ;; *) exit 1 ;; esac; done' \
    2>/dev/null
}

if ! has_contract; then
  sudo mkdir -p /etc/systemd/system/user@.service.d
  printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null
  sudo systemctl daemon-reload
  sudo loginctl enable-linger "$(id -un)"
  sudo systemctl restart "user@$uid.service"
  for _ in $(seq 50); do [[ -S "$runtime/bus" ]] && break; sleep 0.2; done
  has_contract || { echo "systemd user scopes with cpu, memory and pids delegation are unavailable" >&2; exit 1; }
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "XDG_RUNTIME_DIR=$runtime" >> "$GITHUB_ENV"
  echo "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus" >> "$GITHUB_ENV"
fi
echo "systemd user scope delegation: cpu memory pids"
