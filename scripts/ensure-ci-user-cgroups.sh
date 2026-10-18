#!/usr/bin/env bash
set -euo pipefail

# The evaluator resource contract (eval/resources.mjs) runs each task-controlled
# command in a delegated transient systemd --user scope with the cpu, memory and
# pids cgroup v2 controllers. Hosted runners have no user manager for the runner
# account, and older systemd delegates only some controllers to user@.service.
# Provision both, then prove a delegated scope sees all three controllers.

uid="$(id -u)"
runtime="/run/user/$uid"

# shellcheck disable=SC2016 # the inner script is expanded by the scoped /bin/sh, not here
has_contract() {
  XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" \
    systemd-run --user --scope --quiet --collect -p Delegate=yes -- \
    /bin/sh -c 'c=$(cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/cgroup.controllers"); for k in cpu memory pids; do case " $c " in *" $k "*) ;; *) exit 1 ;; esac; done' \
    2>/dev/null
}

if ! has_contract; then
  sudo mkdir -p /etc/systemd/system/user@.service.d
  printf '[Service]\nDelegate=cpu memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null
  sudo systemctl daemon-reload
  # A manager that is already running keeps its old delegation and must restart; otherwise lingering starts it
  # (asynchronously) with the drop-in in place. Restarting while it is still starting fails, so wait for it either way.
  sudo loginctl enable-linger "$(id -un)"
  # Restarting a manager that is still starting fails, so stop it, start it again with the drop-in, and retry a few
  # times. The contract proof below is the gate either way.
  for attempt in 1 2 3 4 5; do
    sudo systemctl stop "user@$uid.service" || true
    if sudo systemctl start "user@$uid.service"; then
      for _ in $(seq 100); do
        systemctl is-active --quiet "user@$uid.service" && [[ -S "$runtime/bus" ]] && break
        sleep 0.2
      done
      has_contract && break
    fi
    echo "user@$uid.service start attempt $attempt did not provide the contract; retrying" >&2
    sleep "$attempt"
  done
  if ! has_contract; then
    echo "systemd user scopes with cpu, memory and pids delegation are unavailable" >&2
    sudo systemctl status "user@$uid.service" --no-pager >&2 || true
    sudo journalctl -u "user@$uid.service" -n 80 --no-pager >&2 || true
    exit 1
  fi
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "XDG_RUNTIME_DIR=$runtime" >> "$GITHUB_ENV"
  echo "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus" >> "$GITHUB_ENV"
fi
echo "systemd user scope delegation: cpu memory pids"
