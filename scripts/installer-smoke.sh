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
# This fixture uses locally generated, unattested packages except in the explicit
# trusted-gh case below. Make that test-only opt-out visible to every installer run.
export NEXUS_VERIFY_ATTESTATION=0
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

# Attestation defaults to auto: verify with a trusted gh when one exists, otherwise install with a
# visible notice. NEXUS_VERIFY_ATTESTATION=1 requires provenance; a PATH shim is never trusted.
# Relocate only the fixed trusted binary locations in a private installer copy so this
# fixture exercises every branch without depending on whether the host has gh installed.
mkdir -p "$TMP/trusted/usr/bin" "$TMP/trusted/usr/local/bin" "$TMP/path-shim" "$TMP/attestation-prefix/bin"
sed "s|/usr/bin/gh|$TMP/trusted/usr/bin/gh|g; s|/usr/local/bin/gh|$TMP/trusted/usr/local/bin/gh|g" \
  "$INSTALLER" > "$TMP/install-test.sh"
chmod +x "$TMP/install-test.sh"
cat > "$TMP/path-shim/gh" <<EOF
#!/bin/sh
printf 'PATH shim invoked\\n' >> '$TMP/path-shim.log'
exit 0
EOF
chmod +x "$TMP/path-shim/gh"
env -u NEXUS_VERIFY_ATTESTATION \
  NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/auto-prefix" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
  PATH="$TMP/path-shim:$PATH" sh "$TMP/install-test.sh" > "$TMP/auto-no-gh.out" 2>&1 \
  || { echo "default auto mode refused to install without a trusted gh" >&2; cat "$TMP/auto-no-gh.out" >&2; exit 1; }
grep -F "build provenance was not verified: no trusted GitHub CLI" "$TMP/auto-no-gh.out" >/dev/null
[ -L "$TMP/auto-prefix/bin/nexus" ] || { echo "default auto mode did not install" >&2; exit 1; }
if NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/attestation-prefix" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" NEXUS_VERIFY_ATTESTATION=1 \
  PATH="$TMP/path-shim:$PATH" sh "$TMP/install-test.sh" > "$TMP/no-trusted-gh.out" 2>&1; then
  echo "installer accepted required provenance without a trusted gh" >&2
  exit 1
fi
grep -F "no trusted GitHub CLI was found" "$TMP/no-trusted-gh.out" >/dev/null
[ ! -e "$TMP/path-shim.log" ] || { echo "installer invoked PATH gh shim" >&2; exit 1; }
if NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/invalid-mode" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" NEXUS_VERIFY_ATTESTATION=yes \
  sh "$INSTALLER" > "$TMP/invalid-mode.out" 2>&1; then
  echo "installer accepted an unsupported attestation mode" >&2
  exit 1
fi
grep -F "NEXUS_VERIFY_ATTESTATION must be" "$TMP/invalid-mode.out" >/dev/null
cat > "$TMP/trusted/usr/bin/gh" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$TMP/trusted/usr/bin/gh"
env -u NEXUS_VERIFY_ATTESTATION \
  NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/auto-failing-gh-prefix" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" \
  sh "$TMP/install-test.sh" > "$TMP/auto-failing-gh.out" 2>&1 \
  || { echo "default auto mode refused to install when gh could not verify" >&2; cat "$TMP/auto-failing-gh.out" >&2; exit 1; }
grep -F "could not verify the attestation" "$TMP/auto-failing-gh.out" >/dev/null
if NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/required-failing-gh-prefix" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" NEXUS_VERIFY_ATTESTATION=1 \
  sh "$TMP/install-test.sh" > "$TMP/required-failing-gh.out" 2>&1; then
  echo "installer accepted a failed required provenance check" >&2
  exit 1
fi
grep -F "provenance attestation verification failed" "$TMP/required-failing-gh.out" >/dev/null
[ ! -e "$TMP/required-failing-gh-prefix/bin/nexus" ] || { echo "failed required provenance still installed" >&2; exit 1; }
cat > "$TMP/trusted/usr/bin/gh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$TRUSTED_GH_LOG"
exit 0
EOF
chmod +x "$TMP/trusted/usr/bin/gh"
NEXUS_VERSION="$VERSION" NEXUS_PREFIX="$TMP/attestation-prefix" \
  NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" NEXUS_VERIFY_ATTESTATION=1 \
  TRUSTED_GH_LOG="$TMP/trusted-gh.log" PATH="$TMP/path-shim:$PATH" \
  sh "$TMP/install-test.sh" > "$TMP/trusted-gh.out" 2>&1
grep -F "verified build provenance" "$TMP/trusted-gh.out" >/dev/null
[ "$(wc -l < "$TMP/trusted-gh.log")" -eq 2 ] || { echo "installer did not verify both provenance subjects" >&2; exit 1; }
[ ! -e "$TMP/path-shim.log" ] || { echo "installer invoked PATH gh shim" >&2; exit 1; }
node - "$TMP/prefix/lib/nexus/$VERSION/.provenance.json" "$VERSION" "$TMP/prefix" "$TMP/prefix/lib/nexus/$VERSION" "$TMP/prefix/bin/nexus" "$NAME" "$TMP/release/download/$VERSION/$NAME" <<'NODE'
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const [recordPath, version, prefix, installedPath, binPath, archive, archivePath] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
assert.equal(record.formatVersion, 1);
assert.equal(record.method, "installer");
assert.equal(record.product, "nexus-code");
assert.equal(record.version, version);
assert.equal(record.prefix, prefix);
assert.equal(record.installedPath, installedPath);
assert.equal(record.binPath, binPath);
assert.equal(record.managed, true);
assert.equal(record.archive, archive);
assert.match(record.archiveSha256, /^[a-f0-9]{64}$/);
assert.equal(record.archiveSha256, crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"));
NODE
# A same-version install is reused only when its recorded package digest matches the downloaded archive.
node - "$TMP/prefix/lib/nexus/$VERSION/.provenance.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const record = JSON.parse(fs.readFileSync(file, "utf8"));
record.archiveSha256 = "0".repeat(64);
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
NODE
printf 'stale-package-content\n' > "$TMP/prefix/lib/nexus/$VERSION/stale.txt"
run_installer
if [ -e "$TMP/prefix/lib/nexus/$VERSION/stale.txt" ]; then
  echo "installer reused a version directory with a different archive digest" >&2
  exit 1
fi

# ACC-PKG-05: bad tag v1.2.3/../x is rejected before network
if NEXUS_VERSION="v1.2.3/../x" sh "$INSTALLER" > "$TMP/bad-tag.out" 2>&1; then
  echo "bad tag unexpectedly accepted" >&2
  exit 1
fi
grep -F "version must be a release tag" "$TMP/bad-tag.out" >/dev/null

# ACC-UPG-07: unsupported compatibility metadata schemas fail before installation.
SCHEMA_VERSION="$VERSION-unsupported-schema"
mkdir -p "$TMP/release/download/$SCHEMA_VERSION" "$TMP/schema-unpack"
tar -xzf "$ARCHIVE" -C "$TMP/schema-unpack"
printf '%s\n' "$SCHEMA_VERSION" > "$TMP/schema-unpack/nexus/VERSION"
node - "$TMP/schema-unpack/nexus" "$SCHEMA_VERSION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, tag] = process.argv.slice(2);
const version = tag.replace(/^v/, "");
const pkgPath = path.join(root, "lib/cli/package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const file = path.join(root, "compatibility.json");
const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
metadata.version = version;
for (const component of Object.keys(metadata.components)) metadata.components[component] = version;
metadata.platforms["linux-x86_64"].archive = `nexus-linux-x86_64-${tag}.tar.gz`;
metadata.schemaVersion = 2;
fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
(cd "$TMP/schema-unpack/nexus" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256)
SCHEMA_ARCHIVE="nexus-linux-x86_64-$SCHEMA_VERSION.tar.gz"
tar -C "$TMP/schema-unpack" -czf "$TMP/release/download/$SCHEMA_VERSION/$SCHEMA_ARCHIVE" nexus
(cd "$TMP/release/download/$SCHEMA_VERSION" && sha256sum "$SCHEMA_ARCHIVE" > SHA256SUMS)
if NEXUS_VERSION="$SCHEMA_VERSION" NEXUS_PREFIX="$TMP/prefix" NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" sh "$INSTALLER" > "$TMP/unsupported-schema.out" 2>&1; then
  echo "installer accepted unsupported compatibility metadata schema" >&2
  exit 1
fi
grep -F "release compatibility metadata is invalid or mismatched" "$TMP/unsupported-schema.out" >/dev/null

# ACC-PKG-05: deleting a dist file then reinstalling repairs it
DELETED="$TMP/prefix/lib/nexus/$VERSION/lib/cli/dist/index.js"
if [ -f "$DELETED" ]; then
  rm "$DELETED"
  [ ! -f "$DELETED" ]
  run_installer
  [ -f "$DELETED" ] || { echo "manifest repair failed to restore deleted file" >&2; exit 1; }
fi

# ACC-PKG-05: NEXUS_FORCE=1 forces re-extraction even when intact
printf 'extraneous-file\n' > "$TMP/prefix/lib/nexus/$VERSION/extra.txt"
NEXUS_FORCE=1 run_installer
[ ! -f "$TMP/prefix/lib/nexus/$VERSION/extra.txt" ] || { echo "NEXUS_FORCE=1 failed to clean reinstall" >&2; exit 1; }

# ACC-PKG-05: no-version with only prereleases prints the latest-prerelease hint
mkdir -p "$TMP/release/api"
printf '[{"tag_name":"v0.1.0-alpha.2","prerelease":true}]\n' > "$TMP/release/api/rel"
if NEXUS_RELEASES_API="http://127.0.0.1:$PORT/api/rel" NEXUS_PREFIX="$TMP/prefix" NEXUS_RELEASE_BASE_URL="http://127.0.0.1:$PORT" sh "$INSTALLER" > "$TMP/no-stable.out" 2>&1; then
  echo "installer unexpectedly succeeded when latest stable is 404" >&2
  exit 1
fi
grep -F "no stable release yet; latest prerelease is v0.1.0-alpha.2 — rerun with NEXUS_VERSION=v0.1.0-alpha.2" "$TMP/no-stable.out" >/dev/null

# Distinct from the version under test, whatever it is, so the upgrade path is always exercised.
UPGRADE_VERSION="$VERSION-upgrade-smoke"
mkdir -p "$TMP/release/download/$UPGRADE_VERSION" "$TMP/upgrade-unpack"
tar -xzf "$ARCHIVE" -C "$TMP/upgrade-unpack"
printf '%s\n' "$UPGRADE_VERSION" > "$TMP/upgrade-unpack/nexus/VERSION"
node - "$TMP/upgrade-unpack/nexus" "$UPGRADE_VERSION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, tag] = process.argv.slice(2);
const version = tag.replace(/^v/, "");
const packagePath = path.join(root, "lib/cli/package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
const metadataPath = path.join(root, "compatibility.json");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
metadata.version = version;
for (const component of Object.keys(metadata.components)) metadata.components[component] = version;
metadata.platforms["linux-x86_64"].archive = `nexus-linux-x86_64-${tag}.tar.gz`;
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
(cd "$TMP/upgrade-unpack/nexus" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256)
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
