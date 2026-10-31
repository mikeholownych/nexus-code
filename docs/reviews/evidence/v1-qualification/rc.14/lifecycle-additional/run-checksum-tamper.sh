#!/usr/bin/env bash
# RC14 E2: an installer run whose checksum index does not match the archive must
# refuse, leaving the existing installation, launcher and user state untouched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
evidence="$(cd "$here/.." && pwd)"
log="$evidence/ubuntu-22-04-node22-checksum-tamper.log"
installer="${NEXUS_RC14_INSTALLER:-/var/tmp/nexus-rc14-assets/install.sh}"
fixture="${NEXUS_RC14_FIXTURE:-/var/tmp/nexus-rc14-lifecycle-fixtures/tampered-release/fixture}"
installer_sha=b243cda661eb0a57890435cfa2170fb50ea8e507aeec595d364d3f2ce71c8125

[ -f "$installer" ] || { echo "missing installer $installer" >&2; exit 2; }
[ -d "$fixture/download/v1.0.0-rc.14" ] || { echo "missing tampered fixture $fixture" >&2; exit 2; }
[ "$(sha256sum "$installer" | awk '{print $1}')" = "$installer_sha" ] || { echo "installer digest mismatch" >&2; exit 2; }
archive_sha=$(sha256sum "$fixture/download/v1.0.0-rc.14/nexus-linux-x86_64-v1.0.0-rc.14.tar.gz" | awk '{print $1}')
[ "$archive_sha" = "52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7" ] || { echo "fixture archive digest mismatch" >&2; exit 2; }

docker run --rm --pull=never --network bridge \
  --mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly" \
  --mount "type=bind,src=$here/static-fixture-server.js,dst=/tmp/server.js,readonly" \
  --mount "type=bind,src=$fixture,dst=/tmp/release-fixture,readonly" \
  --env "FIXTURE_ARCHIVE_SHA=$archive_sha" \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
    set -eu
    NEXUS_VERSION=v1.0.0-rc.14 NEXUS_VERIFY_ATTESTATION=0 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
    export PATH="$HOME/.local/bin:$PATH"
    test "$(nexus --version)" = "1.0.0-rc.14 (16eeb6eeffe7)"
    echo "RUN_BINDING runner=docker:nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 node=$(node --version) nexus=$(nexus --version) fixture_archive_sha256_measured=$FIXTURE_ARCHIVE_SHA installer_sha256_expected=b243cda661eb0a57890435cfa2170fb50ea8e507aeec595d364d3f2ce71c8125"
    link_before=$(readlink "$HOME/.local/bin/nexus")
    manifest_before=$(sha256sum "$HOME/.local/lib/nexus/v1.0.0-rc.14/MANIFEST.sha256")
    mkdir -m 700 -p "$HOME/.nexus"
    printf "checksum-safety-marker\n" > "$HOME/.nexus/marker"; chmod 600 "$HOME/.nexus/marker"
    state_before=$(sha256sum "$HOME/.nexus/marker")
    node /tmp/server.js >/tmp/server.log 2>&1 & server_pid=$!
    trap '\''kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true'\'' EXIT
    for i in 1 2 3 4 5 6 7 8 9 10; do test -s /tmp/fixture-port && break; sleep 0.1; done
    port=$(cat /tmp/fixture-port); test -n "$port"
    if output=$(NEXUS_VERSION=v1.0.0-rc.14 NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$port" \
        NEXUS_VERIFY_ATTESTATION=0 sh /tmp/nexus-install.sh 2>&1); then
      echo "tampered checksum unexpectedly installed"; exit 40
    fi
    printf "%s\n" "$output"
    printf "%s" "$output" | grep -F "SHA-256 verification failed; no installation was changed." >/dev/null
    test "$(readlink "$HOME/.local/bin/nexus")" = "$link_before"
    test "$(sha256sum "$HOME/.nexus/marker")" = "$state_before"
    test "$(nexus --version)" = "1.0.0-rc.14 (16eeb6eeffe7)"
    test "$(sha256sum "$HOME/.local/lib/nexus/v1.0.0-rc.14/MANIFEST.sha256")" = "$manifest_before"
    test -z "$(ls -A "$HOME/.local/lib/nexus" | grep -E "^\\.tmp-upgrade-|^\\.rollback-" || true)"
    echo "checksum_tamper=PASS existing_launcher_and_state_unchanged=true"
  ' > "$log" 2>&1
cat "$log"
