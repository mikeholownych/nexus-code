#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${1:?usage: package-linux.sh VERSION OUTPUT_DIR}
OUT=${2:?usage: package-linux.sh VERSION OUTPUT_DIR}
case "$VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must look like v1.2.3" >&2; exit 2 ;; esac
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

npm --prefix "$ROOT/cli" ci
npm --prefix "$ROOT/cli" run build
cargo build --locked --release --manifest-path "$ROOT/core/Cargo.toml" --bin harness-core --bin nexus-tui

PKG="$WORK/nexus"
mkdir -p "$PKG/bin" "$PKG/lib/core" "$PKG/lib/cli"
cp -R "$ROOT/cli/dist" "$PKG/lib/cli/dist"
cp "$ROOT/cli/package.json" "$ROOT/cli/package-lock.json" "$PKG/lib/cli/"
npm ci --omit=dev --prefix "$PKG/lib/cli"
cp "$ROOT/core/target/release/harness-core" "$ROOT/core/target/release/nexus-tui" "$PKG/lib/core/"
cp "$ROOT/LICENSE" "$PKG/LICENSE"
printf '%s\n' "$VERSION" > "$PKG/VERSION"

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
exec node "$NEXUS_HOME/lib/cli/dist/index.js" "$@"
EOF
chmod 0755 "$PKG/bin/nexus" "$PKG/lib/core/harness-core" "$PKG/lib/core/nexus-tui"
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256)
ARCHIVE="nexus-linux-x86_64-$VERSION.tar.gz"
SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct)
export SOURCE_DATE_EPOCH
tar --sort=name --format=pax --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  --pax-option=delete=atime,delete=ctime -C "$WORK" -cf - nexus | gzip -n > "$OUT/$ARCHIVE"
(cd "$OUT" && sha256sum "$ARCHIVE" > SHA256SUMS)

# Generate lockfile-derived merged CycloneDX SBOM (REQ-REL-108, ACC-SUP-02)
"$ROOT/scripts/generate_sbom.sh" "$OUT/sbom.cdx.json"

# Publish install.sh as release asset (REQ-REL-109)
cp "$ROOT/install.sh" "$OUT/install.sh"

printf 'Built %s\n' "$OUT/$ARCHIVE"
