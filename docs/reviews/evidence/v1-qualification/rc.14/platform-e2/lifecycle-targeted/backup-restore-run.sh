#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
log="${NEXUS_E2_BACKUP_RESTORE_LOG:-$here/backup-restore.out}"
printf 'runner_cwd=%s\nrunner_script_dir=%s\n' "$PWD" "$here"
docker run --rm --pull=never --network bridge \
  --mount "type=bind,src=$here/install.sh,dst=/tmp/nexus-install.sh,readonly" \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
    set -e
   export HOME=/tmp/nexus-rc14-home XDG_CONFIG_HOME=/tmp/nexus-rc14-home/.config XDG_CACHE_HOME=/tmp/nexus-rc14-home/.cache
   mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$HOME/.local/bin"
   export PATH="$HOME/.local/bin:$PATH"
    NEXUS_VERSION=v1.0.0-rc.14 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
    mkdir -p "$HOME/.nexus/tasks" "$HOME/.config/nexus"
    chmod 700 "$HOME/.nexus" "$HOME/.nexus/tasks" "$HOME/.config/nexus"
    printf "live-state-must-be-replaced\\n" > "$HOME/.nexus/tasks/item.json"; chmod 600 "$HOME/.nexus/tasks/item.json"
    printf "LOCAL_LLM_ENDPOINT=http://127.0.0.1:9/v1\\nLOCAL_LLM_MODEL=live-marker\\n" > "$HOME/.config/nexus/config.env"; chmod 600 "$HOME/.config/nexus/config.env"
    backup="$HOME/.nexus/backups/state-backup-20261026T185000Z"
    mkdir -p "$backup/state/tasks" "$backup/config"
    chmod 700 "$HOME/.nexus/backups" "$backup" "$backup/state" "$backup/state/tasks" "$backup/config"
    printf "backup-state-restored\\n" > "$backup/state/tasks/item.json"; chmod 600 "$backup/state/tasks/item.json"
    printf "LOCAL_LLM_ENDPOINT=http://127.0.0.1:9/v1\\nLOCAL_LLM_MODEL=backup-marker\\n" > "$backup/config/config.env"; chmod 600 "$backup/config/config.env"
    printf "%s\\n" "{\"formatVersion\":1,\"kind\":\"nexus-state-config\",\"createdAt\":\"2026-10-26T18:50:00Z\"}" > "$backup/backup.json"; chmod 600 "$backup/backup.json"
    find "$backup" -maxdepth 4 -printf "%y %m %u %p\\n" | sort
    nexus upgrade --restore-backup "$backup"
    grep -Fx "backup-state-restored" "$HOME/.nexus/tasks/item.json" >/dev/null
    grep -Fx "LOCAL_LLM_MODEL=backup-marker" "$HOME/.config/nexus/config.env" >/dev/null
    test "$(stat -c %a "$HOME/.nexus/tasks/item.json")" = 600
    test "$(stat -c %a "$HOME/.config/nexus/config.env")" = 600
    test "$(stat -c %a "$HOME/.nexus/tasks")" = 700
    test "$(nexus --version)" = "1.0.0-rc.14 (16eeb6eeffe7)"
    echo "backup_restore=PASS config_and_state_restored restored_files_mode_0600=true tasks_dir_mode_0700=true"
  ' > "$log" 2>&1
cat "$log"
