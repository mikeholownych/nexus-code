#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
docker run --rm --pull=never --network bridge \
  --mount type=bind,src=/var/tmp/nexus-rc11-e2-platform/installer/install.sh,dst=/tmp/nexus-install.sh,readonly \
  --mount type=bind,src=$here/static-fixture-server.js,dst=/tmp/server.js,readonly \
  --mount type=bind,src=/var/tmp/nexus-rc11-e2-fixtures/tampered-release/fixture,dst=/tmp/release-fixture,readonly \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
    set -e
    NEXUS_VERSION=v1.0.0-rc.11 sh /tmp/nexus-install.sh
    export PATH="$HOME/.local/bin:$PATH"
    link_before=$(readlink "$HOME/.local/bin/nexus")
    package_file="$HOME/.local/lib/nexus/v1.0.0-rc.11/lib/cli/dist/index.js"
    test -f "$package_file"
    package_before=$(sha256sum "$package_file")
    mkdir -m 700 -p "$HOME/.nexus"
    printf "checksum-safety-marker\\n" > "$HOME/.nexus/marker"; chmod 600 "$HOME/.nexus/marker"
    state_before=$(sha256sum "$HOME/.nexus/marker")
    node /tmp/server.js >/tmp/server.log 2>&1 & server_pid=$!
    trap '\''kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true'\'' EXIT
    for i in 1 2 3 4 5 6 7 8 9 10; do test -s /tmp/fixture-port && break; sleep 0.1; done
    port=$(cat /tmp/fixture-port); test -n "$port"
    if output=$(NEXUS_VERSION=v1.0.0-rc.11 NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$port" sh /tmp/nexus-install.sh 2>&1); then
      echo "tampered checksum unexpectedly installed"; exit 40
    fi
    printf "%s\\n" "$output"
    printf "%s" "$output" | grep -F "SHA-256 verification failed; no installation was changed." >/dev/null
    link_after=$(readlink "$HOME/.local/bin/nexus")
    test "$link_after" = "$link_before"
    package_after=$(sha256sum "$package_file")
    test "$package_after" = "$package_before"
    test "$(sha256sum "$HOME/.nexus/marker")" = "$state_before"
    test "$(nexus --version)" = "1.0.0-rc.11 (8d4e5319f1a3)"
    echo "package_file=$package_file sha256=${package_before%% *}"
    echo "checksum_tamper=PASS same_version_existing_package_file_launcher_and_state_unchanged=true"
  '
