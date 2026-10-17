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

validate_tag() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[-0-9A-Za-z.]+)?$' || fail "version must be a release tag like v1.2.3 or v1.2.3-alpha.1 (got: $1)."
}

if [ "$VERSION" != "latest" ]; then
  validate_tag "$VERSION"
fi

if [ "$VERSION" = "latest" ]; then
  API_BASE=${NEXUS_RELEASES_API:-"https://api.github.com/repos/$REPO/releases"}
  API_TMP=$(mktemp -d "${TMPDIR:-/tmp}/nexus-api.XXXXXX") || fail "could not create temporary directory."
  api_cleanup() { rm -rf "$API_TMP"; }
  trap api_cleanup EXIT HUP INT TERM

  LATEST_CODE=$(curl -sSL --show-error -H 'Accept: application/vnd.github+json' -D "$API_TMP/headers" -o "$API_TMP/latest.json" -w "%{http_code}" "$API_BASE/latest" 2>"$API_TMP/curl.err" || echo "000")

  if [ "$LATEST_CODE" = "200" ]; then
    VERSION=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$API_TMP/latest.json" | head -n 1)
    [ -n "$VERSION" ] || fail "GitHub returned no stable release tag."
    validate_tag "$VERSION"
  elif [ "$LATEST_CODE" = "403" ]; then
    if grep -qiE 'x-ratelimit-remaining:[[:space:]]*0' "$API_TMP/headers" 2>/dev/null; then
      fail "GitHub API rate limit exceeded; set NEXUS_VERSION=vX to bypass the release lookup, or set GITHUB_TOKEN."
    fi
    fail "GitHub API returned HTTP 403; set NEXUS_VERSION=vX to bypass the release lookup."
  elif [ "$LATEST_CODE" = "404" ]; then
    PREREL_CODE=$(curl -sSL --show-error -H 'Accept: application/vnd.github+json' -o "$API_TMP/releases.json" -w "%{http_code}" "$API_BASE?per_page=1" 2>/dev/null || echo "000")
    if [ "$PREREL_CODE" = "200" ]; then
      PREREL_TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$API_TMP/releases.json" | head -n 1)
      if [ -n "$PREREL_TAG" ]; then
        fail "no stable release yet; latest prerelease is $PREREL_TAG — rerun with NEXUS_VERSION=$PREREL_TAG"
      fi
    fi
    fail "could not find latest stable release (HTTP 404 from $API_BASE/latest)."
  else
    fail "could not query GitHub releases API (HTTP $LATEST_CODE); network failure or host unreachable."
  fi
  rm -rf "$API_TMP"
  trap - EXIT HUP INT TERM
fi

ARCHIVE="nexus-linux-x86_64-$VERSION.tar.gz"
URL="$BASE/download/$VERSION"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/nexus-install.XXXXXX") || fail "could not create temporary directory."
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
curl -fsSL --show-error --retry 2 "$URL/$ARCHIVE" -o "$TMP/$ARCHIVE" || fail "download failed for $ARCHIVE."
curl -fsSL --show-error --retry 2 "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "could not download release checksums."
grep -F "  $ARCHIVE" "$TMP/SHA256SUMS" > "$TMP/expected.sha256" || fail "checksum entry for $ARCHIVE is missing."
(cd "$TMP" && sha256sum --check --status expected.sha256) || fail "SHA-256 verification failed; no installation was changed."

if [ "${NEXUS_VERIFY_ATTESTATION:-auto}" != "0" ] && command -v gh >/dev/null 2>&1; then
  if gh attestation verify "$TMP/$ARCHIVE" -R "$REPO" >/dev/null 2>&1; then
    printf 'nexus installer: verified build provenance attestation for %s\n' "$ARCHIVE"
  elif [ "${NEXUS_VERIFY_ATTESTATION:-auto}" = "1" ]; then
    fail "provenance attestation verification failed for $ARCHIVE."
  fi
fi

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

FORCE=${NEXUS_FORCE:-0}
NEEDS_EXTRACT=1
if [ -d "$VERSION_DIR" ] && [ "$FORCE" != "1" ]; then
  if [ -x "$VERSION_DIR/bin/nexus" ] && \
     [ -x "$VERSION_DIR/lib/core/harness-core" ] && \
     [ -x "$VERSION_DIR/lib/core/nexus-tui" ] && \
     [ "$(cat "$VERSION_DIR/VERSION" 2>/dev/null || true)" = "$VERSION" ]; then
    if [ -f "$VERSION_DIR/MANIFEST.sha256" ]; then
      if (cd "$VERSION_DIR" && sha256sum --check --status MANIFEST.sha256 2>/dev/null); then
        NEEDS_EXTRACT=0
      fi
    else
      NEEDS_EXTRACT=0
    fi
  fi
fi

if [ "$NEEDS_EXTRACT" = "1" ]; then
  mkdir -p "$TMP/unpack"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP/unpack" || fail "archive extraction failed."
  PACKAGE="$TMP/unpack/nexus"
  [ -x "$PACKAGE/bin/nexus" ] && [ -x "$PACKAGE/lib/core/harness-core" ] && [ -x "$PACKAGE/lib/core/nexus-tui" ] && [ "$(cat "$PACKAGE/VERSION" 2>/dev/null || true)" = "$VERSION" ] || fail "release archive is incomplete or has a mismatched version."
  if [ -f "$PACKAGE/MANIFEST.sha256" ]; then
    (cd "$PACKAGE" && sha256sum --check --status MANIFEST.sha256) || fail "release archive failed manifest checksum verification."
  fi
  rm -rf "$VERSION_DIR"
  mv "$PACKAGE" "$VERSION_DIR"
fi
NEXT="$BIN_DIR/.nexus-link.$$"
ln -s "$VERSION_DIR/bin/nexus" "$NEXT"
mv -f "$NEXT" "$LINK"
printf 'Installed Nexus Code %s in %s\n' "$VERSION" "$VERSION_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf 'Add this to your shell profile if needed: export PATH="%s:$PATH"\n' "$BIN_DIR" ;; esac
"$LINK" --version
