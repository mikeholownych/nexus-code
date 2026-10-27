#!/usr/bin/env bash
# RC10 E2 lifecycle: alpha.2 install -> RC10 upgrade -> alpha.2 rollback ->
# RC10 reinstall -> same-version repair -> documented manual uninstall.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
installer=/tmp/nexus-install.sh
log="$here/ubuntu-22-04-node22-lifecycle.log"
expected_rc=1.0.0-rc.10
expected_rc_full="1.0.0-rc.10 (16ee8ca36438)"
[ -f "$installer" ] || { echo "missing installer at $installer" >&2; exit 2; }

docker run --rm --pull=never --network bridge \
  --mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly" \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
  set -eu
  id
  node --version
  export PATH="$HOME/.local/bin:$PATH"
  install() { NEXUS_VERIFY_ATTESTATION=0 NEXUS_VERSION="$1" sh /tmp/nexus-install.sh; }

  # Synthetic user state and configuration that every step must preserve.
  mkdir -p "$HOME/.nexus/tasks" "$HOME/.config/nexus" "$HOME/.local/bin"
  chmod 700 "$HOME/.nexus" "$HOME/.nexus/tasks" "$HOME/.config/nexus"
  printf "lifecycle-state\n" > "$HOME/.nexus/tasks/item.json"; chmod 600 "$HOME/.nexus/tasks/item.json"
  printf "LOCAL_LLM_MODEL=lifecycle-marker\n" > "$HOME/.config/nexus/config.env"; chmod 600 "$HOME/.config/nexus/config.env"
  printf "adjacent-user-file\n" > "$HOME/.local/bin/user-tool"; chmod 755 "$HOME/.local/bin/user-tool"

  echo "== install alpha.2"
  install v0.1.0-alpha.2
  alpha_version="$(nexus --version)"
  echo "alpha_version=$alpha_version"
  printf "%s" "$alpha_version" | grep -F "0.1.0-alpha.2" >/dev/null
  alpha_dirs="$(find "$HOME/.local/lib/nexus" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort)"
  echo "alpha_dirs=$alpha_dirs"
  test -n "$alpha_dirs"

  echo "== upgrade to RC10"
  install v1.0.0-rc.10
  test "$(nexus --version)" = "'"$expected_rc_full"'"
  rc_dirs="$(find "$HOME/.local/lib/nexus" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort)"
  echo "rc_dirs=$rc_dirs"
  test -d "$HOME/.local/lib/nexus/v1.0.0-rc.10"
  test -n "$alpha_dirs"
  for d in $alpha_dirs; do test -d "$HOME/.local/lib/nexus/$d"; done
  grep -Fx "lifecycle-state" "$HOME/.nexus/tasks/item.json" >/dev/null
  grep -Fx "LOCAL_LLM_MODEL=lifecycle-marker" "$HOME/.config/nexus/config.env" >/dev/null
  grep -Fx "adjacent-user-file" "$HOME/.local/bin/user-tool" >/dev/null

  echo "== rollback to alpha.2"
  install v0.1.0-alpha.2
  printf "%s" "$(nexus --version)" | grep -F "0.1.0-alpha.2" >/dev/null
  test -d "$HOME/.local/lib/nexus/v1.0.0-rc.10"
  grep -Fx "lifecycle-state" "$HOME/.nexus/tasks/item.json" >/dev/null

  echo "== reinstall RC10"
  install v1.0.0-rc.10
  test "$(nexus --version)" = "'"$expected_rc_full"'"

  echo "== same-version repair"
  pkg="$HOME/.local/lib/nexus/v1.0.0-rc.10"
  victim="$(find "$pkg" -type f | sort | head -n 1)"
  before="$(sha256sum "$victim" | cut -d" " -f1)"
  rm "$victim"
  test ! -e "$victim"
  install v1.0.0-rc.10
  after="$(sha256sum "$victim" | cut -d" " -f1)"
  echo "repair_file=$victim before=$before after=$after"
  test "$before" = "$after"
  test "$(nexus --version)" = "'"$expected_rc_full"'"

  echo "== documented manual uninstall"
  rm "$HOME/.local/bin/nexus"
  rm -rf "$HOME/.local/lib/nexus"
  test ! -e "$HOME/.local/bin/nexus"
  test ! -e "$HOME/.local/lib/nexus"
  grep -Fx "lifecycle-state" "$HOME/.nexus/tasks/item.json" >/dev/null
  grep -Fx "LOCAL_LLM_MODEL=lifecycle-marker" "$HOME/.config/nexus/config.env" >/dev/null
  grep -Fx "adjacent-user-file" "$HOME/.local/bin/user-tool" >/dev/null
  echo "lifecycle=PASS upgrade_rollback_reinstall_repair_uninstall=true state_config_retained=true"
' > "$log" 2>&1
cat "$log"
