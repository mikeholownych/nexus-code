#!/usr/bin/env bash
# Nexus Code Software Bill of Materials (SBOM) Generator (REQ-REL-108, ACC-SUP-02)
# Generates a merged, lockfile-derived CycloneDX 1.5 JSON SBOM for Rust and Node production dependencies.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_FILE="${1:-${ROOT_DIR}/dist/sbom.cdx.json}"

mkdir -p "$(dirname "$OUT_FILE")"
WORK=$(mktemp -d)
cleanup() {
  rm -rf "$WORK"
  rm -f "${ROOT_DIR}/core/harness-core.cdx.json"
}
trap cleanup EXIT

# 1. Generate Rust production SBOM from Cargo.lock using cargo-cyclonedx
(cd "${ROOT_DIR}/core" && cargo cyclonedx --format json --spec-version 1.5)
mv "${ROOT_DIR}/core/harness-core.cdx.json" "$WORK/cargo.cdx.json"

# 2. Generate Node production SBOM from cli/package-lock.json using cyclonedx-npm
npx --yes @cyclonedx/cyclonedx-npm \
  --package-lock-only \
  --omit dev \
  --spec-version 1.5 \
  --output-format JSON \
  --output-file "$WORK/npm.cdx.json" \
  "${ROOT_DIR}/cli/package.json"

# 3. Merge Cargo and npm SBOMs using cyclonedx-cli
cyclonedx merge \
  --input-files "$WORK/cargo.cdx.json" "$WORK/npm.cdx.json" \
  --output-file "$OUT_FILE" \
  --output-version v1_5

# 4. Normalize metadata for reproducible builds if SOURCE_DATE_EPOCH or git commit is available
python3 - <<EOF
import json, uuid, datetime, os

out_path = "$OUT_FILE"
root_dir = "$ROOT_DIR"

epoch_str = os.environ.get("SOURCE_DATE_EPOCH")
if not epoch_str:
    try:
        import subprocess
        epoch_str = subprocess.check_output(
            ["git", "-C", root_dir, "log", "-1", "--format=%ct"],
            text=True
        ).strip()
    except Exception:
        epoch_str = "1700000000"

epoch = int(epoch_str)
with open(out_path, "r+", encoding="utf-8") as f:
    data = json.load(f)
    if "metadata" not in data:
        data["metadata"] = {}
    data["metadata"]["timestamp"] = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    namespace = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    data["serialNumber"] = f"urn:uuid:{uuid.uuid5(namespace, str(epoch))}"
    f.seek(0)
    json.dump(data, f, indent=2)
    f.truncate()
EOF

# 5. Validate the merged CycloneDX SBOM
cyclonedx validate --input-file "$OUT_FILE" --fail-on-errors
echo "Generated and validated CycloneDX SBOM: $OUT_FILE"
