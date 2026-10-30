#!/usr/bin/env bash
set -euo pipefail
docker run --rm --pull=never --network bridge \
  --mount type=bind,src=/var/tmp/nexus-rc11-e2-platform/installer/install.sh,dst=/tmp/nexus-install.sh,readonly \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
    set -eu
    export PATH="$HOME/.local/bin:$PATH"
    NEXUS_VERSION=v1.0.0-rc.10 NEXUS_VERIFY_ATTESTATION=0 sh /tmp/nexus-install.sh >/tmp/install-rc10.log 2>&1
    test "$(nexus --version)" = "1.0.0-rc.10 (16ee8ca36438)"
    mkdir -m 700 -p "$HOME/.nexus/tasks" "$HOME/.config/nexus"
    printf "upgrade-state-marker\\n" > "$HOME/.nexus/tasks/item.json"; chmod 600 "$HOME/.nexus/tasks/item.json"
    printf "LOCAL_LLM_MODEL=upgrade-config-marker\\n" > "$HOME/.config/nexus/config.env"; chmod 600 "$HOME/.config/nexus/config.env"
    printf "adjacent-user-marker\\n" > "$HOME/.local/bin/user-tool"; chmod 755 "$HOME/.local/bin/user-tool"
    old_link=$(readlink -f "$HOME/.local/bin/nexus")
    NEXUS_VERIFY_ATTESTATION=0 nexus upgrade --version v1.0.0-rc.11 --yes
    test "$(nexus --version)" = "1.0.0-rc.11 (8d4e5319f1a3)"
    test -d "$HOME/.local/lib/nexus/v1.0.0-rc.10"
    test -d "$HOME/.local/lib/nexus/v1.0.0-rc.11"
    new_link=$(readlink -f "$HOME/.local/bin/nexus")
    test "$new_link" != "$old_link"
    grep -Fx "upgrade-state-marker" "$HOME/.nexus/tasks/item.json" >/dev/null
    grep -Fx "LOCAL_LLM_MODEL=upgrade-config-marker" "$HOME/.config/nexus/config.env" >/dev/null
    grep -Fx "adjacent-user-marker" "$HOME/.local/bin/user-tool" >/dev/null
    test "$(stat -c %a "$HOME/.nexus/tasks/item.json")" = 600
    test "$(stat -c %a "$HOME/.config/nexus/config.env")" = 600
    echo "successful_updater_upgrade=PASS source=rc.10 target=rc.11 old_release_retained=true state_config_adjacent_data_preserved=true"
  '
