#!/usr/bin/env bash
set -euo pipefail

# The sandbox requires --disable-userns. Ubuntu 22.04's bubblewrap 0.6.1 predates
# that option. Build a patched upstream release when the packaged executable
# lacks it; releases before 0.12.0 are affected by CVE-2026-87766.
readonly BWRAP=/usr/bin/bwrap
readonly SOURCE_URL=https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz
readonly SOURCE_SHA256=0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d

supports_required_userns_control() {
  [[ -x "$BWRAP" ]] || return 1

  local version_output major minor patch
  version_output=$("$BWRAP" --version 2>/dev/null) || return 1
  [[ "$version_output" =~ bubblewrap[[:space:]]+([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  major=${BASH_REMATCH[1]}
  minor=${BASH_REMATCH[2]}
  patch=${BASH_REMATCH[3]}
  ((major > 0 || minor > 12 || (minor == 12 && patch >= 0))) || return 1
  "$BWRAP" --help 2>&1 | grep -Fq -- '--disable-userns'
}

if supports_required_userns_control; then
  "$BWRAP" --version
  exit 0
fi

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nexus-bubblewrap.XXXXXX")"
trap 'rm -rf "$work"' EXIT
archive="$work/bubblewrap-0.13.1.tar.xz"

curl --fail --location --silent --show-error --retry 3 "$SOURCE_URL" -o "$archive"
printf '%s  %s\n' "$SOURCE_SHA256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$work"
meson setup "$work/build" "$work/bubblewrap-0.13.1" \
  --prefix=/usr \
  -Dtests=false \
  -Dselinux=disabled \
  -Dbash_completion=disabled \
  -Dzsh_completion=disabled \
  -Dman=disabled
ninja -C "$work/build"

# The build runs as the unprivileged CI user. Only the resulting executable is
# installed into the ephemeral runner, without setuid permissions.
sudo install -o root -g root -m 0755 "$work/build/bwrap" "$BWRAP"
"$BWRAP" --version | grep -F '0.13.1'
supports_required_userns_control
