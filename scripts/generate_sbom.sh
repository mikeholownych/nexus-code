#!/usr/bin/env bash
# Nexus Code Software Bill of Materials (SBOM) Generator (REQ-REL-108, ACC-SUP-02)
# Generates a merged, lockfile-derived CycloneDX 1.5 JSON SBOM for Rust and Node production dependencies.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_FILE="${1:-${ROOT_DIR}/dist/sbom.cdx.json}"

mkdir -p "$(dirname "$OUT_FILE")"
WORK=$(mktemp -d)
RUST_TARGET="x86_64-unknown-linux-gnu"
cleanup() {
  rm -rf "$WORK"
  rm -f "${ROOT_DIR}/core/harness-core.cdx.json"
}
trap cleanup EXIT

# 1. Generate Rust SBOM for the exact platform shipped by package-linux.sh.
(cd "${ROOT_DIR}/core" && cargo cyclonedx --format json --spec-version 1.5 --target "$RUST_TARGET")
mv "${ROOT_DIR}/core/harness-core.cdx.json" "$WORK/cargo.cdx.json"

# cargo-cyclonedx can include compile-only dependencies in its package graph.
# ACC-SUP-02 is defined over the lockfile production closure for the shipped
# binaries, so retain normal and build edges for the shipped target and remove
# components outside that closure before merging the npm BOM.
cargo tree \
  --locked \
  --manifest-path "${ROOT_DIR}/core/Cargo.toml" \
  --target "$RUST_TARGET" \
  --edges normal,build \
  --prefix none \
  --format '{p}' > "$WORK/cargo-production-tree.txt"
CARGO_SBOM="$WORK/cargo.cdx.json" \
CARGO_TREE="$WORK/cargo-production-tree.txt" \
python3 - <<'PY'
import json
import os
import re
from urllib.parse import unquote

sbom_path = os.environ["CARGO_SBOM"]
tree_path = os.environ["CARGO_TREE"]
with open(sbom_path, encoding="utf-8") as f:
    bom = json.load(f)

def identity(name, version):
    # Cargo treats hyphens and underscores as equivalent crate-name spelling.
    return (name.replace("-", "_").lower(), version)

expected = set()
with open(tree_path, encoding="utf-8") as f:
    for line in f:
        match = re.match(r"^(.+?) v([^ ]+)(?: |$)", line.strip())
        if not match:
            raise SystemExit(f"Cannot parse Cargo production dependency identity: {line.rstrip()!r}")
        expected.add(identity(match.group(1), match.group(2)))

root = bom.get("metadata", {}).get("component", {})
root_purl = root.get("purl", "")
root_match = re.match(r"^pkg:cargo/([^@?]+)@([^?]+)", root_purl)
if not root_match:
    raise SystemExit("Cargo SBOM has no parseable root package identity")
root_identity = identity(unquote(root_match.group(1)), root_match.group(2))
if root_identity not in expected:
    raise SystemExit("Cargo production dependency graph does not contain the SBOM root package")
expected.remove(root_identity)

components_by_identity = {}
non_cargo_components = []
for component in bom.get("components", []):
    purl = component.get("purl", "")
    if not purl.startswith("pkg:cargo/"):
        non_cargo_components.append(component)
        continue
    match = re.match(r"^pkg:cargo/([^@?]+)@([^?]+)", purl)
    if not match:
        raise SystemExit(f"Cargo SBOM component has an invalid package URL: {purl!r}")
    key = identity(unquote(match.group(1)), match.group(2))
    components_by_identity.setdefault(key, []).append(component)

ambiguous = sorted(key for key, values in components_by_identity.items() if len(values) != 1)
if ambiguous:
    raise SystemExit(f"Cargo SBOM has ambiguous source identities for: {ambiguous}")
actual = set(components_by_identity)
missing = sorted(expected - actual)
if missing:
    raise SystemExit(f"Cargo SBOM omits production dependencies: {missing}")

kept_cargo = [components_by_identity[key][0] for key in sorted(expected)]
kept_refs = {component["bom-ref"] for component in kept_cargo}
root_ref = root.get("bom-ref")
if not root_ref:
    raise SystemExit("Cargo SBOM root has no bom-ref")
metadata_refs = set()
def add_component_refs(component):
    ref = component.get("bom-ref")
    if ref:
        if ref in metadata_refs:
            raise SystemExit(f"Cargo SBOM metadata has duplicate bom-ref: {ref}")
        metadata_refs.add(ref)
    for child in component.get("components", []):
        add_component_refs(child)
add_component_refs(root)
if root_ref not in metadata_refs:
    raise SystemExit("Cargo SBOM metadata root reference is missing")
kept_refs.update(metadata_refs)

# Refuse to rewrite a malformed or incomplete graph. Edges to known components
# excluded by the production-closure selection are intentional compile-only
# edges; unknown refs indicate that the input graph cannot be safely pruned.
all_refs = set()
for component in bom.get("components", []):
    ref = component.get("bom-ref")
    if ref:
        if ref in all_refs or ref in metadata_refs:
            raise SystemExit(f"Cargo SBOM has duplicate bom-ref: {ref}")
        all_refs.add(ref)
all_refs.update(metadata_refs)
for dependency in bom.get("dependencies", []):
    ref = dependency.get("ref")
    if ref not in all_refs:
        raise SystemExit(f"Cargo SBOM dependency record refers to unknown bom-ref: {ref}")
    for target_ref in dependency.get("dependsOn", []):
        if target_ref not in all_refs:
            raise SystemExit(f"Cargo SBOM dependency edge refers to unknown bom-ref: {target_ref}")

removed = actual - expected
removed_edges = 0
bom["components"] = non_cargo_components + kept_cargo
filtered_dependencies = []
for dependency in bom.get("dependencies", []):
    if dependency.get("ref") not in kept_refs:
        continue
    removed_edges += sum(1 for ref in dependency.get("dependsOn", []) if ref not in kept_refs)
    dependency["dependsOn"] = [ref for ref in dependency.get("dependsOn", []) if ref in kept_refs]
    filtered_dependencies.append(dependency)
bom["dependencies"] = filtered_dependencies

with open(sbom_path, "w", encoding="utf-8") as f:
    json.dump(bom, f, indent=2)
    f.write("\n")
print(
    f"Retained {len(expected)} Cargo production dependencies; "
    f"removed {len(removed)} compile-only components and {removed_edges} compile-only edges"
)
PY

# 2. Generate the Node production SBOM from cli/package-lock.json with npm's
# built-in CycloneDX 1.5 generator. Clear npm prefix variables inherited by
# nested invocations so npm resolves the CLI manifest and lockfile directly.
env -u npm_config_local_prefix \
  -u npm_config_prefix \
  -u NPM_CONFIG_LOCAL_PREFIX \
  -u NPM_CONFIG_PREFIX \
  npm --prefix "${ROOT_DIR}/cli" sbom \
  --package-lock-only \
  --omit=dev \
  --sbom-format cyclonedx > "$WORK/npm.cdx.json"

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
    if "component" not in data["metadata"]:
        data["metadata"]["component"] = {"type": "application", "name": "nexus-code"}
    else:
        data["metadata"]["component"]["name"] = "nexus-code"
    f.seek(0)
    json.dump(data, f, indent=2)
    f.truncate()
EOF

# 5. Validate the merged CycloneDX SBOM
cyclonedx validate --input-file "$OUT_FILE" --fail-on-errors
echo "Generated and validated CycloneDX SBOM: $OUT_FILE"

# 6. Generate SHA-256 checksum and backwards-compatible sbom.json
(cd "$(dirname "$OUT_FILE")" && sha256sum "$(basename "$OUT_FILE")" > "$(basename "$OUT_FILE").sha256")
if [[ "$(basename "$OUT_FILE")" == "sbom.cdx.json" ]]; then
  cp "$OUT_FILE" "$(dirname "$OUT_FILE")/sbom.json"
  (cd "$(dirname "$OUT_FILE")" && sha256sum "sbom.json" > "sbom.json.sha256")
fi
