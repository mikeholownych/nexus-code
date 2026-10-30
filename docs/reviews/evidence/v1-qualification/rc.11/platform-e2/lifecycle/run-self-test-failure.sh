#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
docker run --rm --pull=never --network bridge \
 --mount type=bind,src=/var/tmp/nexus-rc11-e2-platform/installer/install.sh,dst=/tmp/nexus-install.sh,readonly \
 --mount type=bind,src=$here/static-fixture-server.js,dst=/tmp/server.js,readonly \
 --mount type=bind,src=/var/tmp/nexus-rc11-e2-fixtures/broken-release/fixture,dst=/tmp/release-fixture,readonly \
 nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
   set -e
   NEXUS_VERSION=v1.0.0-rc.11 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
   export PATH="$HOME/.local/bin:$PATH"
   installed="$HOME/.local/lib/nexus/v1.0.0-rc.11/lib/cli/dist/index.js"
   installed_before=$(sha256sum "$installed")
   link_before=$(readlink "$HOME/.local/bin/nexus")
   mkdir -p "$HOME/.nexus/tasks"; chmod 700 "$HOME/.nexus" "$HOME/.nexus/tasks"
   printf "self-test-state-marker\\n" > "$HOME/.nexus/tasks/marker"; chmod 600 "$HOME/.nexus/tasks/marker"
   state_before=$(sha256sum "$HOME/.nexus/tasks/marker")
   node /tmp/server.js >/tmp/server.log 2>&1 & server_pid=$!
   trap '\''kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true'\'' EXIT
   for i in 1 2 3 4 5 6 7 8 9 10; do test -s /tmp/fixture-port && break; sleep 0.1; done
   port=$(cat /tmp/fixture-port); test -n "$port"
   if output=$(NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$port" nexus upgrade --version v1.0.0-rc.11 --force --yes 2>&1); then
     echo "broken package unexpectedly upgraded"; exit 40
   fi
   printf "%s\\n" "$output"
   printf "%s" "$output" | grep -F "Unpacked binary failed staging self-test" >/dev/null
   test "$(readlink "$HOME/.local/bin/nexus")" = "$link_before"
   test "$(sha256sum "$installed")" = "$installed_before"
   test "$(sha256sum "$HOME/.nexus/tasks/marker")" = "$state_before"
   test "$(nexus --version)" = "1.0.0-rc.11 (8d4e5319f1a3)"
   echo "upgrade_self_test_failure=PASS existing_install_and_user_state_unchanged=true"
 '
