#!/usr/bin/env bash
set -euo pipefail
INSTALLER=${1:?usage: installer-smoke.sh INSTALLER ARCHIVE}
ARCHIVE=${2:?usage: installer-smoke.sh INSTALLER ARCHIVE}
TMP=$(mktemp -d)
SERVER_PID=
cleanup() { [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
NAME=$(basename "$ARCHIVE")
VERSION=${NAME#nexus-linux-x86_64-}
VERSION=${VERSION%.tar.gz}
mkdir -p "$TMP/release/download/$VERSION" "$TMP/prefix/bin"
cp "$ARCHIVE" "$TMP/release/download/$VERSION/$NAME"
(cd "$TMP/release/download/$VERSION" && sha256sum "$NAME" > SHA256SUMS)
python3 "$(dirname "$0")/package-smoke-http.py" "$TMP/release" > "$TMP/http.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  PORT=$(sed -n 's/^PORT=//p' "$TMP/http.log" | head -n 1)
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "${PORT:-}" ] || { cat "$TMP/http.log" >&2; echo "HTTP fixture did not start" >&2; exit 1; }
run_installer() {
  NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/prefix" NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
    sh "$INSTALLER"
}
run_installer
"$TMP/prefix/bin/nexus" --version | grep -F "${VERSION#v}" >/dev/null
run_installer
UPGRADE_VERSION=v0.1.0-alpha.2
mkdir -p "$TMP/release/download/$UPGRADE_VERSION" "$TMP/upgrade-unpack"
tar -xzf "$ARCHIVE" -C "$TMP/upgrade-unpack"
printf '%s\n' "$UPGRADE_VERSION" > "$TMP/upgrade-unpack/nexus/VERSION"
UPGRADE_ARCHIVE="nexus-linux-x86_64-$UPGRADE_VERSION.tar.gz"
tar -C "$TMP/upgrade-unpack" -czf "$TMP/release/download/$UPGRADE_VERSION/$UPGRADE_ARCHIVE" nexus
(cd "$TMP/release/download/$UPGRADE_VERSION" && sha256sum "$UPGRADE_ARCHIVE" > SHA256SUMS)
NEXUS_VERSION="$UPGRADE_VERSION" NEXUS_PREFIX="$TMP/prefix" NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" sh "$INSTALLER"
[ "$(readlink "$TMP/prefix/bin/nexus")" = "$TMP/prefix/lib/nexus/$UPGRADE_VERSION/bin/nexus" ]
printf 'preserve-me\n' > "$TMP/prefix/bin/other"
grep -Fx preserve-me "$TMP/prefix/bin/other" >/dev/null
cp "$TMP/release/download/$VERSION/SHA256SUMS" "$TMP/good-sums"
printf 'bad  %s\n' "nexus-linux-x86_64-$VERSION.tar.gz" > "$TMP/release/download/$VERSION/SHA256SUMS"
LINK_BEFORE=$(readlink "$TMP/prefix/bin/nexus")
if run_installer > "$TMP/bad-checksum.out" 2>&1; then echo "checksum mismatch unexpectedly installed" >&2; exit 1; fi
[ "$(readlink "$TMP/prefix/bin/nexus")" = "$LINK_BEFORE" ]
mv "$TMP/good-sums" "$TMP/release/download/$VERSION/SHA256SUMS"
mkdir -p "$TMP/conflict/bin"
printf 'unrelated file\n' > "$TMP/conflict/bin/nexus"
if NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/conflict" NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" sh "$INSTALLER" > "$TMP/conflict.out" 2>&1; then echo "installer overwrote a non-Nexus path" >&2; exit 1; fi
grep -Fx 'unrelated file' "$TMP/conflict/bin/nexus" >/dev/null
printf 'INSTALLER_SMOKE_PASS\n'
