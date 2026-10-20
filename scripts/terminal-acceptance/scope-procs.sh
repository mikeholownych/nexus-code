#!/usr/bin/env bash
# Return the number of processes in a terminal test's systemd scope. A zero is
# emitted only when the scope is proven empty or systemd confirms it is gone.
nexus_terminal_scope_procs() {
  local unit="$1"
  local cgroup_root="${NEXUS_CGROUP_ROOT:-/sys/fs/cgroup}"
  local load_state active_state control_group process_file count

  load_state="$(systemctl --user show --property=LoadState --value "$unit.scope" 2>/dev/null)" || return 2
  if [[ "$load_state" == "not-found" ]]; then
    printf '0\n'
    return 0
  fi
  [[ "$load_state" == "loaded" ]] || return 2

  active_state="$(systemctl --user show --property=ActiveState --value "$unit.scope" 2>/dev/null)" || return 2
  control_group="$(systemctl --user show --property=ControlGroup --value "$unit.scope" 2>/dev/null)" || return 2

  if [[ -n "$control_group" ]]; then
    [[ "$control_group" == /* && "$control_group" != *"/../"* && "$control_group" != */.. ]] || return 2
    process_file="${cgroup_root%/}${control_group}/cgroup.procs"
    if [[ -f "$process_file" && -r "$process_file" ]]; then
      count="$(awk 'BEGIN { invalid = 0 } { if ($0 !~ /^[0-9]+$/) invalid = 1 } END { if (invalid) exit 2; print NR }' "$process_file")" || return 2
      printf '%s\n' "$count"
      return 0
    fi
  fi

  # A stopped, loaded unit with no remaining cgroup has no processes. An
  # active unit with missing/unreadable cgroup data is an unknown measurement.
  if [[ "$active_state" == "inactive" && -z "$control_group" ]]; then
    printf '0\n'
    return 0
  fi
  return 2
}
