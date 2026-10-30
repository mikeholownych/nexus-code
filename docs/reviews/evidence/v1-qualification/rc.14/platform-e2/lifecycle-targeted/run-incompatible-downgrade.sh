#!/usr/bin/env bash
# RC14 E2: an incompatible-state downgrade must be refused fail-closed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
log="$here/ubuntu-22-04-node22-incompatible-downgrade.log"
fixture="$here/fixtures/incompatible-downgrade"
log="${NEXUS_E2_INCOMPATIBLE_LOG:-$here/ubuntu-22-04-node22-incompatible-downgrade.log}"
[ -d "$fixture" ] || { echo "missing fixture at $fixture" >&2; exit 2; }
[ -f "$here/install.sh" ] || { echo "missing installer at $here/install.sh" >&2; exit 2; }
docker run --rm --pull=never --network bridge \
  --mount "type=bind,src=$here/install.sh,dst=/tmp/nexus-install.sh,readonly" \
  --mount "type=bind,src=$here/incompatible-server.js,dst=/tmp/server.js,readonly" \
  --mount "type=bind,src=$fixture,dst=/tmp/incompat-fixture,readonly" \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
  set -eu
   export HOME=/tmp/nexus-rc14-home XDG_CONFIG_HOME=/tmp/nexus-rc14-home/.config XDG_CACHE_HOME=/tmp/nexus-rc14-home/.cache
   mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$HOME/.local/bin"
   export PATH="$HOME/.local/bin:$PATH"
  NEXUS_VERSION=v1.0.0-rc.14 NEXUS_VERIFY_ATTESTATION=0 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
  test "$(nexus --version)" = "1.0.0-rc.14 (16eeb6eeffe7)"
  installed="$HOME/.local/lib/nexus/v1.0.0-rc.14/lib/cli/dist/index.js"
  before=$(sha256sum "$installed" | cut -d" " -f1)
  link_before=$(readlink -f "$HOME/.local/bin/nexus")
  node -e "const c=require(\"/tmp/incompat-fixture/download/v1.0.0-rc.4/compatibility.json\");if(c.compatibility.stateSchemaVersion!==1||c.version!==\"1.0.0-rc.4\")process.exit(1)"
  rm -f /tmp/incompat-port
  node /tmp/server.js >/tmp/server.log 2>&1 & server_pid=$!
  trap '\''kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true'\'' EXIT
  for i in $(seq 1 50); do [ -s /tmp/incompat-port ] && break; sleep 0.1; done
  port=$(cat /tmp/incompat-port); test -n "$port"
  set +e
  NEXUS_RELEASES_API="http://127.0.0.1:$port/api/releases" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$port" \
  NEXUS_VERIFY_ATTESTATION=0 nexus upgrade --version v1.0.0-rc.4 --allow-downgrade --yes >/tmp/upgrade.log 2>&1
  rc=$?
  set -e
  cat /tmp/upgrade.log
  test "$rc" -ne 0
  grep -F "Downgrade refused: Target version v1.0.0-rc.4 uses state schema version 1, which cannot read current state schema version 2" /tmp/upgrade.log >/dev/null
  test "$(nexus --version)" = "1.0.0-rc.14 (16eeb6eeffe7)"
  test "$(readlink -f "$HOME/.local/bin/nexus")" = "$link_before"
  test "$(sha256sum "$installed" | cut -d" " -f1)" = "$before"
  test ! -e "$HOME/.local/lib/nexus/v1.0.0-rc.4"
  echo "incompatible_downgrade=PASS refused=true state_schema=1 current_schema=2 launcher_and_cli_entrypoint_unchanged=true"
  ' > "$log" 2>&1
cat "$log"
