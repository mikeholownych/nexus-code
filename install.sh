#!/bin/sh
set -eu

REPO=mikeholownych/nexus-code
BASE=${NEXUS_RELEASE_BASE_URL:-"https://github.com/$REPO/releases"}
VERSION=${NEXUS_VERSION:-latest}
PREFIX=${NEXUS_PREFIX:-"$HOME/.local"}

fail() { printf 'nexus installer: %s\n' "$*" >&2; exit 1; }
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) ;;
  *) fail "unsupported system $(uname -s)/$(uname -m); supported: Linux x86-64 (glibc)." ;;
esac
command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required; install Node.js and retry."
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node --version 2>/dev/null || echo unknown))."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."

if [ "$VERSION" = latest ]; then
  RELEASE_JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest") || fail "could not find latest stable release."
  VERSION=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || fail "GitHub returned no stable release tag."
fi
case "$VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "version must be a release tag like v1.2.3." ;; esac
ARCHIVE="nexus-linux-x86_64-$VERSION.tar.gz"
URL="$BASE/download/$VERSION"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/nexus-install.XXXXXX") || fail "could not create temporary directory."
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
curl -fL --retry 2 "$URL/$ARCHIVE" -o "$TMP/$ARCHIVE" || fail "download failed for $ARCHIVE."
curl -fL --retry 2 "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "could not download release checksums."
grep -F "  $ARCHIVE" "$TMP/SHA256SUMS" > "$TMP/expected.sha256" || fail "checksum entry for $ARCHIVE is missing."
(cd "$TMP" && sha256sum --check --status expected.sha256) || fail "SHA-256 verification failed; no installation was changed."

VERSION_DIR="$PREFIX/lib/nexus/$VERSION"
BIN_DIR="$PREFIX/bin"
LINK="$BIN_DIR/nexus"
mkdir -p "$PREFIX/lib/nexus" "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  fail "$LINK exists and is not a symlink; left it unchanged."
fi
if [ -L "$LINK" ]; then
  OLD=$(readlink "$LINK")
  case "$OLD" in "$PREFIX/lib/nexus/"*) ;; *) fail "$LINK points outside the Nexus installation; left it unchanged." ;; esac
fi
if [ -e "$VERSION_DIR" ]; then
  [ -x "$VERSION_DIR/bin/nexus" ] && [ -x "$VERSION_DIR/lib/core/harness-core" ] && [ -x "$VERSION_DIR/lib/core/nexus-tui" ] && [ "$(cat "$VERSION_DIR/VERSION" 2>/dev/null || true)" = "$VERSION" ] || fail "existing version directory is incomplete: $VERSION_DIR; left it unchanged."
else
  mkdir "$TMP/unpack"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP/unpack" || fail "archive extraction failed."
  PACKAGE="$TMP/unpack/nexus"
  [ -x "$PACKAGE/bin/nexus" ] && [ -x "$PACKAGE/lib/core/harness-core" ] && [ -x "$PACKAGE/lib/core/nexus-tui" ] && [ "$(cat "$PACKAGE/VERSION" 2>/dev/null || true)" = "$VERSION" ] || fail "release archive is incomplete or has a mismatched version."
  mv "$PACKAGE" "$VERSION_DIR"
fi
NEXT="$BIN_DIR/.nexus-link.$$"
ln -s "$VERSION_DIR/bin/nexus" "$NEXT"
mv -f "$NEXT" "$LINK"
printf 'Installed Nexus Code %s in %s\n' "$VERSION" "$VERSION_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf 'Add this to your shell profile if needed: export PATH="%s:$PATH"\n' "$BIN_DIR" ;; esac
"$LINK" --version
