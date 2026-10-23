#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:?usage: package-linux.sh VERSION OUTPUT_DIR}
OUT=${2:?usage: package-linux.sh VERSION OUTPUT_DIR}
APPROVED_RUST_BUILD_IMAGE='rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb'
case "$VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must look like v1.2.3" >&2; exit 2 ;; esac
if [[ -z "${NEXUS_BUILD_CONTAINER_IMAGE:-}" ]]; then
  if [[ "${NEXUS_ALLOW_HOST_RUST_BUILD:-}" != "1" ]]; then
    echo "NEXUS_BUILD_CONTAINER_IMAGE must use the approved digest-pinned Rust 1.95 Bookworm builder (set NEXUS_ALLOW_HOST_RUST_BUILD=1 only for local development)" >&2
    exit 2
  fi
elif [[ "$NEXUS_BUILD_CONTAINER_IMAGE" != "$APPROVED_RUST_BUILD_IMAGE" ]]; then
  echo "NEXUS_BUILD_CONTAINER_IMAGE must use the approved digest-pinned Rust 1.95 Bookworm builder" >&2
  exit 2
fi
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

npm --prefix "$ROOT/cli" ci
npm --prefix "$ROOT/cli" run build

if [[ -n "${NEXUS_BUILD_CONTAINER_IMAGE:-}" ]]; then
  if [[ ! "$NEXUS_BUILD_CONTAINER_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "NEXUS_BUILD_CONTAINER_IMAGE must be pinned by sha256 digest" >&2
    exit 2
  fi
  command -v docker >/dev/null || { echo "docker is required for the pinned Rust build image" >&2; exit 2; }
  mkdir -p "$WORK/rust-build"
  docker run --rm --pull=always --platform linux/amd64 \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$ROOT,dst=/nexus-source,readonly" \
    --mount "type=bind,src=$WORK/rust-build,dst=/nexus-build" \
    --workdir /nexus-source \
    --env HOME=/tmp/nexus-package-build-home \
    --env CARGO_HOME=/nexus-build/cargo-home \
    --env CARGO_TARGET_DIR=/nexus-build/target \
    --env RUSTUP_HOME=/usr/local/rustup \
    "$NEXUS_BUILD_CONTAINER_IMAGE" \
    cargo build --locked --release --manifest-path /nexus-source/core/Cargo.toml --bin harness-core --bin nexus-tui
  RUST_CORE_TARGET="$WORK/rust-build/target/release"
else
  cargo build --locked --release --manifest-path "$ROOT/core/Cargo.toml" --bin harness-core --bin nexus-tui
  RUST_CORE_TARGET="$ROOT/core/target/release"
fi

PKG="$WORK/nexus"
mkdir -p "$PKG/bin" "$PKG/lib/core" "$PKG/lib/cli"
cp -R "$ROOT/cli/dist" "$PKG/lib/cli/dist"
cp "$ROOT/cli/package.json" "$ROOT/cli/package-lock.json" "$PKG/lib/cli/"
npm ci --omit=dev --prefix "$PKG/lib/cli"
cp "$RUST_CORE_TARGET/harness-core" "$RUST_CORE_TARGET/nexus-tui" "$PKG/lib/core/"
command -v readelf >/dev/null || { echo "readelf is required to verify package glibc compatibility" >&2; exit 2; }
for binary in "$PKG/lib/core/harness-core" "$PKG/lib/core/nexus-tui"; do
  required_glibc=$(readelf --version-info --wide "$binary" | grep -oE 'Name: GLIBC_[0-9]+(\.[0-9]+)+' | sed 's/.*GLIBC_//' | sort -V | tail -n 1)
  if [[ -n "$required_glibc" ]]; then
    IFS=. read -r glibc_major glibc_minor _ <<< "$required_glibc"
    if (( glibc_major > 2 || (glibc_major == 2 && glibc_minor > 35) )); then
      echo "$binary requires GLIBC_$required_glibc, above the GLIBC_2.35 compatibility ceiling" >&2
      exit 1
    fi
  fi
done
cp "$ROOT/LICENSE" "$PKG/LICENSE"
printf '%s\n' "$VERSION" > "$PKG/VERSION"

SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct)
export SOURCE_DATE_EPOCH
GIT_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
BUILD_DATE=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
ARCHIVE="nexus-linux-x86_64-$VERSION.tar.gz"
STATE_SCHEMA_VERSION=$(node --input-type=module - "$PKG/lib/cli/dist/core/state.js" <<'EOF'
import { pathToFileURL } from 'node:url';
const { CURRENT_STATE_SCHEMA_VERSION: version } = await import(pathToFileURL(process.argv[2]).href);
if (!Number.isSafeInteger(version) || version < 1) throw new Error('packaged client has no valid state schema');
process.stdout.write(String(version));
EOF
)

# Embed the compatibility contract in the attested archive. The detached asset
# adds the archive digest after the archive is built and is covered by SHA256SUMS.
cat > "$PKG/compatibility.json" <<EOF
{
  "schemaVersion": 1,
  "product": "nexus-code",
  "version": "${VERSION#v}",
  "revision": "$GIT_COMMIT",
  "builtAt": "$BUILD_DATE",
  "minimumUpdaterVersion": "0.1.0-alpha.2",
  "components": {
    "cli": "${VERSION#v}",
    "core": "${VERSION#v}",
    "tui": "${VERSION#v}",
    "harness": "${VERSION#v}"
  },
  "compatibility": {
    "configSchemaVersion": 1,
    "stateSchemaVersion": $STATE_SCHEMA_VERSION,
    "minSupportedConfigVersion": 1,
    "minSupportedStateVersion": 0
  },
  "platforms": {
    "linux-x86_64": {
      "archive": "$ARCHIVE",
      "os": "linux",
      "arch": "x86_64",
      "libc": "glibc-2.35"
    }
  }
}
EOF
node "$ROOT/scripts/validate_compatibility.mjs" "$PKG/compatibility.json"

cargo about generate -m "$ROOT/core/Cargo.toml" -c "$ROOT/about.toml" "$ROOT/about.hbs" > "$WORK/notices-rust.txt"
npx --yes license-checker-rseidelsohn --production --plainVertical --start "$PKG/lib/cli" > "$WORK/notices-npm.txt"
cat > "$PKG/THIRD_PARTY_NOTICES.txt" <<'EOF'
================================================================================
Nexus Code Third-Party Software Notices and Licenses
================================================================================

This package contains third-party software components licensed under open-source
licenses. The following sections provide notices and license texts for all
runtime and statically-linked dependencies included in this distribution.

================================================================================
Section 1: Rust Components (harness-core & nexus-tui)
================================================================================
EOF
cat "$WORK/notices-rust.txt" >> "$PKG/THIRD_PARTY_NOTICES.txt"
cat >> "$PKG/THIRD_PARTY_NOTICES.txt" <<'EOF'

================================================================================
Section 2: Node.js / npm Components (CLI Runtime)
================================================================================
EOF
cat "$WORK/notices-npm.txt" >> "$PKG/THIRD_PARTY_NOTICES.txt"
cp "$PKG/THIRD_PARTY_NOTICES.txt" "$OUT/THIRD_PARTY_NOTICES.txt"
cat > "$PKG/bin/nexus" <<'EOF'
#!/bin/sh
set -eu
NEXUS_HOME=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)
export NEXUS_HOME
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -n "${HOME:-}" ] && [ -f "$HOME/.config/nexus/config.env" ]; then
  _ca=$(sed -n 's/^[[:space:]]*NODE_EXTRA_CA_CERTS[[:space:]]*=[[:space:]]*//p' "$HOME/.config/nexus/config.env" | tail -n 1 | sed "s/^['\"]//;s/['\"]$//")
  if [ -n "$_ca" ]; then
    case "$_ca" in
      "~/"*) _ca="$HOME/${_ca#\~/}" ;;
    esac
    export NODE_EXTRA_CA_CERTS="$_ca"
  fi
  unset _ca
fi
exec node "$NEXUS_HOME/lib/cli/dist/index.js" "$@"
EOF
chmod 0755 "$PKG/bin/nexus" "$PKG/lib/core/harness-core" "$PKG/lib/core/nexus-tui"
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256)
tar --sort=name --format=pax --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  --pax-option=delete=atime,delete=ctime -C "$WORK" -cf - nexus | gzip -n > "$OUT/$ARCHIVE"

# The detached metadata repeats only the authenticated in-archive contract and
# adds the digest of the exact archive. The release checksum index covers both.
ARCHIVE_SHA=$(sha256sum "$OUT/$ARCHIVE" | awk '{print $1}')
node - "$PKG/compatibility.json" "$OUT/compatibility.json" "$ARCHIVE" "$ARCHIVE_SHA" <<'NODE'
const fs = require("node:fs");
const [source, destination, archive, sha256] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(source, "utf8"));
metadata.platforms["linux-x86_64"].sha256 = sha256;
if (metadata.platforms["linux-x86_64"].archive !== archive) throw new Error("compatibility archive name mismatch");
fs.writeFileSync(destination, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
(cd "$OUT" && sha256sum "$ARCHIVE" compatibility.json > SHA256SUMS)

# Generate lockfile-derived merged CycloneDX SBOM (REQ-REL-108, ACC-SUP-02)
"$ROOT/scripts/generate_sbom.sh" "$OUT/sbom.cdx.json"

# Publish install.sh as release asset (REQ-REL-109)
cp "$ROOT/install.sh" "$OUT/install.sh"

node "$ROOT/scripts/validate_compatibility.mjs" "$OUT/compatibility.json" --require-digest

printf 'Built %s\n' "$OUT/$ARCHIVE"
