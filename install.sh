#!/bin/sh
set -eu

REPO=mikeholownych/nexus-code
BASE=${NEXUS_RELEASE_BASE_URL:-"https://github.com/$REPO/releases"}
VERSION=${NEXUS_VERSION:-latest}
PREFIX=${NEXUS_PREFIX:-"$HOME/.local"}

fail() { printf 'nexus installer: %s\n' "$*" >&2; exit 1; }

# Report interruption with the shell's conventional signal exit codes. The EXIT
# trap still removes temporary files; re-arm these after any trap reset so a
# later Ctrl-C or `kill -TERM` cannot leave a half-written installation.
exit_on_int() { trap - INT; exit 130; }
exit_on_term() { trap - TERM; exit 143; }
arm_signal_exits() { trap exit_on_int INT; trap exit_on_term TERM; }
arm_signal_exits

# This installer writes only under $HOME. Under sudo, $HOME usually points at
# root's home, so the launcher would not be visible to the invoking user.
# Plain root (containers, CI) is left alone; an intentional root install can
# opt in explicitly.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && [ "${NEXUS_INSTALL_ALLOW_SUDO:-0}" != "1" ]; then
  printf 'nexus installer: do not run this installer with sudo.\n' >&2
  printf 'Nexus installs into your home directory and does not need root access.\n' >&2
  printf 'Re-run without sudo. To install for root intentionally, set NEXUS_INSTALL_ALLOW_SUDO=1.\n' >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) ;;
  *) fail "unsupported system $(uname -s)/$(uname -m); supported: Linux x86-64 (glibc)." ;;
esac
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required; install Node.js and retry."
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required (found $(node --version 2>/dev/null || echo unknown))."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."

# An in-flight `nexus upgrade` owns this journal and the launcher symlink. A
# concurrent install would repoint the launcher underneath recovery and make
# rollback target the wrong package. Inspect the journal read-only: an absent
# or closed journal is fine, but a pending or unrecognised journal must be
# resolved by the upgrade path before another install is allowed.
UPGRADE_JOURNAL="$PREFIX/lib/nexus/.upgrade-journal.json"
if [ -e "$UPGRADE_JOURNAL" ] || [ -L "$UPGRADE_JOURNAL" ]; then
  JOURNAL_STATE=$(node - "$UPGRADE_JOURNAL" <<'NODE' || printf unrecognized
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[2];
try {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) process.exit(1);
  const state = JSON.parse(fs.readFileSync(file, "utf8")).state;
  process.stdout.write(["idle", "complete", "rolled_back"].includes(state) ? state : "unrecognized");
} catch { process.exit(1); }
NODE
)
  case "$JOURNAL_STATE" in
    idle|complete|rolled_back) ;;
    *) fail "pending upgrade journal at $UPGRADE_JOURNAL (state: $JOURNAL_STATE); run 'nexus upgrade --recover' before installing another version." ;;
  esac
fi

VERIFY_ATTESTATION=${NEXUS_VERIFY_ATTESTATION-auto}
case "$VERIFY_ATTESTATION" in
  auto|0|1) ;;
  *) fail "NEXUS_VERIFY_ATTESTATION must be auto (verify when a trusted GitHub CLI is present), 1 (require verification) or 0 (skip verification)." ;;
esac
TRUSTED_GH=
if [ -x /usr/bin/gh ]; then
  TRUSTED_GH=/usr/bin/gh
elif [ -x /usr/local/bin/gh ]; then
  TRUSTED_GH=/usr/local/bin/gh
fi
if [ "$VERIFY_ATTESTATION" = "1" ] && [ -z "$TRUSTED_GH" ]; then
  fail "provenance attestation is required (NEXUS_VERIFY_ATTESTATION=1) but no trusted GitHub CLI was found at /usr/bin/gh or /usr/local/bin/gh; install gh or set NEXUS_VERIFY_ATTESTATION=0."
fi

validate_tag() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[-0-9A-Za-z.]+)?$' || fail "version must be a release tag like v1.2.3 or v1.2.3-alpha.1 (got: $1)."
}

if [ "$VERSION" != "latest" ]; then
  validate_tag "$VERSION"
fi

if [ "$VERSION" = "latest" ]; then
  API_BASE=${NEXUS_RELEASES_API:-"https://api.github.com/repos/$REPO/releases"}
  API_AUTH=
  # Only the real GitHub API receives a caller-supplied token; a custom
  # NEXUS_RELEASES_API is often a local fixture and must not harvest it.
  if [ -z "${NEXUS_RELEASES_API:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    case "$GITHUB_TOKEN" in
      *[!A-Za-z0-9._~-]*)
        printf 'nexus installer: ignoring GITHUB_TOKEN with unexpected characters; set NEXUS_VERSION instead if the rate limit persists.\n' >&2 ;;
      *) API_AUTH="Bearer $GITHUB_TOKEN" ;;
    esac
  fi
  api_get() {
    if [ -n "$API_AUTH" ]; then
      curl -sSL --show-error -H 'Accept: application/vnd.github+json' -H "Authorization: $API_AUTH" "$@"
    else
      curl -sSL --show-error -H 'Accept: application/vnd.github+json' "$@"
    fi
  }
  API_TMP=$(mktemp -d "${TMPDIR:-/tmp}/nexus-api.XXXXXX") || fail "could not create temporary directory."
  api_cleanup() { rm -rf "$API_TMP"; }
  trap api_cleanup EXIT HUP
  arm_signal_exits

  LATEST_CODE=$(api_get -D "$API_TMP/headers" -o "$API_TMP/latest.json" -w "%{http_code}" "$API_BASE/latest" 2>"$API_TMP/curl.err" || echo "000")

  if [ "$LATEST_CODE" = "200" ]; then
    VERSION=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$API_TMP/latest.json" | head -n 1)
    [ -n "$VERSION" ] || fail "GitHub returned no stable release tag."
    validate_tag "$VERSION"
  elif [ "$LATEST_CODE" = "403" ]; then
    if grep -qiE 'x-ratelimit-remaining:[[:space:]]*0' "$API_TMP/headers" 2>/dev/null; then
      fail "GitHub API rate limit exceeded; set NEXUS_VERSION=vX to bypass the release lookup, or set GITHUB_TOKEN when using GitHub's API."
    fi
    fail "GitHub API returned HTTP 403; set NEXUS_VERSION=vX to bypass the release lookup."
  elif [ "$LATEST_CODE" = "404" ]; then
    PREREL_CODE=$(api_get -o "$API_TMP/releases.json" -w "%{http_code}" "$API_BASE?per_page=1" 2>/dev/null || echo "000")
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
  arm_signal_exits
fi

ARCHIVE="nexus-linux-x86_64-$VERSION.tar.gz"
NORMALIZED_VERSION=${VERSION#v}
URL="$BASE/download/$VERSION"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/nexus-install.XXXXXX") || fail "could not create temporary directory."
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP
arm_signal_exits
curl -fsSL --show-error --retry 2 "$URL/$ARCHIVE" -o "$TMP/$ARCHIVE" || fail "download failed for $ARCHIVE."
curl -fsSL --show-error --retry 2 "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS" || fail "could not download release checksums."
grep -F "  $ARCHIVE" "$TMP/SHA256SUMS" > "$TMP/expected.sha256" || fail "checksum entry for $ARCHIVE is missing."
(cd "$TMP" && sha256sum --check --status expected.sha256) || fail "SHA-256 verification failed; no installation was changed."
ARCHIVE_SHA256=$(sha256sum "$TMP/$ARCHIVE" | awk '{print $1}')

if [ "$VERIFY_ATTESTATION" != "0" ] && [ -n "$TRUSTED_GH" ]; then
  if "$TRUSTED_GH" attestation verify "$TMP/$ARCHIVE" -R "$REPO" >/dev/null 2>&1 && \
     "$TRUSTED_GH" attestation verify "$TMP/SHA256SUMS" -R "$REPO" >/dev/null 2>&1; then
    printf 'nexus installer: verified build provenance for %s and its checksum index\n' "$ARCHIVE"
  elif [ "$VERIFY_ATTESTATION" = "1" ]; then
    fail "provenance attestation verification failed for $ARCHIVE or SHA256SUMS."
  else
    printf 'nexus installer: build provenance was not verified: %s could not verify the attestation (it may need gh auth login); the SHA-256 checksum was verified. Set NEXUS_VERIFY_ATTESTATION=1 to require provenance.\n' "$TRUSTED_GH" >&2
  fi
elif [ "$VERIFY_ATTESTATION" = "auto" ]; then
  printf 'nexus installer: build provenance was not verified: no trusted GitHub CLI at /usr/bin/gh or /usr/local/bin/gh; the SHA-256 checksum was verified. Set NEXUS_VERIFY_ATTESTATION=1 to require provenance.\n' >&2
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
      if [ "$NEEDS_EXTRACT" = "0" ]; then
        if ! node - "$VERSION_DIR/.provenance.json" "$ARCHIVE_SHA256" <<'NODE'
const fs = require("node:fs");
const [file, archiveSha256] = process.argv.slice(2);
try {
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (record.archiveSha256 !== archiveSha256) process.exit(1);
} catch { process.exit(1); }
NODE
        then
          NEEDS_EXTRACT=1
        fi
      fi
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
  PACKAGE_VERSION_OUTPUT=$("$PACKAGE/bin/nexus" --version 2>&1) || fail "release binary failed its pre-install self-test."
  PACKAGE_VERSION_REPORTED=$(printf '%s\n' "$PACKAGE_VERSION_OUTPUT" | sed -n '1s/[[:space:]].*$//p')
  [ "$PACKAGE_VERSION_REPORTED" = "$NORMALIZED_VERSION" ] || fail "release binary reported version '$PACKAGE_VERSION_REPORTED' instead of '$NORMALIZED_VERSION' during self-test."
  if [ -f "$PACKAGE/compatibility.json" ]; then
    node - "$PACKAGE/compatibility.json" "$VERSION" "$ARCHIVE" <<'NODE' || fail "release compatibility metadata is invalid or mismatched."
const fs = require("node:fs");
const [file, version, archive] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const asset = data.platforms?.["linux-x86_64"];
const compatible = data.schemaVersion === 1 && data.product === "nexus-code" &&
  data.version === version.replace(/^v/, "") &&
  typeof data.revision === "string" && /^[a-f0-9]{7,64}$/i.test(data.revision) &&
  typeof data.builtAt === "string" && !Number.isNaN(Date.parse(data.builtAt)) &&
  asset?.archive === archive && asset.os === "linux" && asset.arch === "x86_64" &&
  data.compatibility && Number.isSafeInteger(data.compatibility.configSchemaVersion) &&
  Number.isSafeInteger(data.compatibility.stateSchemaVersion) &&
  Number.isSafeInteger(data.compatibility.minSupportedConfigVersion) &&
  Number.isSafeInteger(data.compatibility.minSupportedStateVersion) &&
  data.compatibility.minSupportedConfigVersion <= data.compatibility.configSchemaVersion &&
  data.compatibility.minSupportedStateVersion <= data.compatibility.stateSchemaVersion;
if (!compatible) process.exit(1);
NODE
  fi
  # A rename persists the directory entry, not file data: flush the extracted
  # package before it replaces anything, or a power loss can leave 0-byte files.
  sync
  rm -rf "$VERSION_DIR"
  mv "$PACKAGE" "$VERSION_DIR"
fi
node - "$VERSION_DIR/compatibility.json" "$VERSION" "$PREFIX" "$VERSION_DIR" "$LINK" "$ARCHIVE" "$ARCHIVE_SHA256" "$VERSION_DIR/.provenance.json" <<'NODE'
const fs = require("node:fs");
const [metadataPath, version, prefix, installedPath, binPath, archive, archiveSha256, output] = process.argv.slice(2);
let metadata = null;
try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch {}
const record = {
  formatVersion: 1,
  method: "installer",
  product: "nexus-code",
  version,
  ...(metadata?.revision ? { revision: metadata.revision } : {}),
  ...(metadata?.builtAt ? { builtAt: metadata.builtAt } : {}),
  prefix,
  installedPath,
  binPath,
  managed: true,
  archive,
  archiveSha256,
};
fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
fs.chmodSync(output, 0o644);
NODE
# Make the package move and provenance durable before the launcher points at
# them, then make the launcher switch itself durable.
sync
NEXT="$BIN_DIR/.nexus-link.$$"
ln -s "$VERSION_DIR/bin/nexus" "$NEXT"
mv -f "$NEXT" "$LINK"
sync
printf 'Installed Nexus Code %s in %s\n' "$VERSION" "$VERSION_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) printf 'Add this to your shell profile if needed: export PATH="%s:$PATH"\n' "$BIN_DIR" ;; esac
"$LINK" --version
