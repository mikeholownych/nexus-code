#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
docker run --rm --pull=never --network bridge \
 --mount type=bind,src=/tmp/nexus-install.sh,dst=/tmp/nexus-install.sh,readonly \
 --mount type=bind,src=$here/process-crash-server.js,dst=/tmp/server.js,readonly \
 --mount type=bind,src=/var/tmp/nexus-rc10-e2-fixtures/process-crash-release,dst=/tmp/crash-fixture,readonly \
 nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
   set -e
   NEXUS_VERSION=v1.0.0-rc.10 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
   export PATH="$HOME/.local/bin:$PATH"
   installed="$HOME/.local/lib/nexus/v1.0.0-rc.10/lib/cli/dist/index.js"
   original_sha=$(awk "{print \$1}" /tmp/crash-fixture/original-index.sha256)
   broken_sha=$(awk "{print \$1}" /tmp/crash-fixture/broken-index.sha256)
   test "$(sha256sum "$installed" | cut -d" " -f1)" = "$original_sha"
   mkdir -p "$HOME/.nexus/tasks"; chmod 700 "$HOME/.nexus" "$HOME/.nexus/tasks"
   printf "process-crash-state-marker\\n" > "$HOME/.nexus/tasks/marker"; chmod 600 "$HOME/.nexus/tasks/marker"
   state_before=$(sha256sum "$HOME/.nexus/tasks/marker")
   node /tmp/server.js >/tmp/server.log 2>&1 & server_pid=$!
   trap '\''kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true'\'' EXIT
   for i in 1 2 3 4 5 6 7 8 9 10; do test -s /tmp/crash-fixture-port && break; sleep 0.1; done
   port=$(cat /tmp/crash-fixture-port); test -n "$port"
   NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$port" setsid nexus upgrade --version v1.0.0-rc.10 --force --yes >/tmp/upgrade.log 2>&1 & upgrade_pid=$!
   pgid=$(ps -o pgid= -p "$upgrade_pid" | tr -d " ")
   test "$pgid" = "$upgrade_pid"
   reached=0
   for i in $(seq 1 300); do
     state=$(node -e "const fs=require(\"node:fs\");try{console.log(JSON.parse(fs.readFileSync(process.env.HOME+\"/.local/lib/nexus/.upgrade-journal.json\",\"utf8\")).state)}catch{console.log(\"none\")}")
     current=$(sha256sum "$installed" 2>/dev/null | cut -d" " -f1 || true)
     if [ "$state" = switched ] && [ "$current" = "$broken_sha" ]; then reached=1; break; fi
     if ! kill -0 "$upgrade_pid" 2>/dev/null; then cat /tmp/upgrade.log; echo "updater exited before switched-state checkpoint"; exit 41; fi
     sleep 0.02
   done
   test "$reached" = 1
   node -e "const fs=require(\"node:fs\");const j=JSON.parse(fs.readFileSync(process.env.HOME+\"/.local/lib/nexus/.upgrade-journal.json\",\"utf8\"));if(j.state!==\"switched\"||!j.replacementBackupDir||!fs.existsSync(j.replacementBackupDir))process.exit(1);console.log(\"pre-kill durable journal state=\"+j.state+\" backup_exists=true\")"
   /bin/kill -KILL -- "-$pgid"
   set +e; wait "$upgrade_pid" 2>/dev/null; killed_rc=$?; set -e
   echo "updater_sigkill_rc=$killed_rc"
   for proc in /proc/[0-9]*/cmdline; do
     [ -r "$proc" ] || continue
     cmd=$(tr "\\000" " " < "$proc" 2>/dev/null || true)
     case "$cmd" in *"$HOME/.local/lib/nexus/v1.0.0-rc.10/lib/cli/dist/index.js --version"*) pid=${proc#/proc/}; pid=${pid%/cmdline}; kill -KILL "$pid" 2>/dev/null || true;; esac
   done
   state=$(node -e "const fs=require(\"node:fs\");console.log(JSON.parse(fs.readFileSync(process.env.HOME+\"/.local/lib/nexus/.upgrade-journal.json\",\"utf8\")).state)")
   test "$state" = switched
   test "$(sha256sum "$installed" | cut -d" " -f1)" = "$broken_sha"
   test "$(sha256sum "$HOME/.nexus/tasks/marker")" = "$state_before"
   echo "after_sigkill_durable_state=switched target_installed=true user_state_preserved=true"
   nexus upgrade --recover
   test "$(sha256sum "$installed" | cut -d" " -f1)" = "$original_sha"
   test "$(sha256sum "$HOME/.nexus/tasks/marker")" = "$state_before"
   test "$(nexus --version)" = "1.0.0-rc.10 (16ee8ca36438)"
   node -e "const fs=require(\"node:fs\");const j=JSON.parse(fs.readFileSync(process.env.HOME+\"/.local/lib/nexus/.upgrade-journal.json\",\"utf8\"));if(j.state!==\"rolled_back\")process.exit(1);if(!fs.existsSync(j.displacedTargetDir))process.exit(2);if(j.stagingDir&&fs.existsSync(j.stagingDir))process.exit(3);console.log(\"post-recovery journal=\"+j.state+\" failed_target_retained=true staging_removed=true\")"
   test "$(find "$HOME/.local/lib/nexus" -maxdepth 1 -name ".tmp-upgrade-*" | wc -l)" = 0
   nexus upgrade --recover
   test "$(sha256sum "$installed" | cut -d" " -f1)" = "$original_sha"
   test "$(nexus --version)" = "1.0.0-rc.10 (16ee8ca36438)"
   echo "updater_process_crash_recovery=PASS original_package_restored=true staging_cleanup_asserted=true idempotent=true; POWER_LOSS_NOT_TESTED"
 '
