#!/usr/bin/env bash
# Nexus Code Software Bill of Materials (SBOM) Generator (REL-001..REL-004)
# Generates a standard CycloneDX-compatible JSON SBOM and SHA-256 checksum manifest.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist"

mkdir -p "${OUT_DIR}"

GIT_COMMIT="$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || echo "UNKNOWN_COMMIT")"
GIT_BRANCH="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "UNKNOWN_BRANCH")"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SERIAL_UUID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "urn:uuid:00000000-0000-0000-0000-000000000000")"

echo "[*] Generating Software Bill of Materials (SBOM)..."

python3 - <<EOF
import json
import os
import hashlib
from datetime import datetime

root_dir = "${ROOT_DIR}"
out_dir = "${OUT_DIR}"
git_commit = "${GIT_COMMIT}"
timestamp = "${TIMESTAMP}"
serial_number = "urn:uuid:${SERIAL_UUID}"

# 1. Parse Node dependencies from cli/package.json
cli_pkg_path = os.path.join(root_dir, "cli", "package.json")
with open(cli_pkg_path, "r", encoding="utf-8") as f:
    cli_pkg = json.load(f)

components = []

# Primary CLI component
components.append({
    "type": "application",
    "name": cli_pkg.get("name", "local-code-harness"),
    "version": cli_pkg.get("version", "1.2.1"),
    "description": cli_pkg.get("description", ""),
    "licenses": [{"license": {"id": cli_pkg.get("license", "MIT")}}],
    "purl": f"pkg:npm/{cli_pkg.get('name')}@{cli_pkg.get('version')}"
})

for dep_name, dep_ver in cli_pkg.get("dependencies", {}).items():
    clean_ver = dep_ver.lstrip("^~")
    components.append({
        "type": "library",
        "name": dep_name,
        "version": clean_ver,
        "scope": "required",
        "purl": f"pkg:npm/{dep_name}@{clean_ver}"
    })

# 2. Parse Rust dependencies from core/Cargo.toml
cargo_path = os.path.join(root_dir, "core", "Cargo.toml")
with open(cargo_path, "r", encoding="utf-8") as f:
    cargo_lines = f.readlines()

in_deps = False
for line in cargo_lines:
    line = line.strip()
    if line.startswith("[dependencies]"):
        in_deps = True
        continue
    elif line.startswith("[") and in_deps:
        in_deps = False
        continue

    if in_deps and "=" in line and not line.startswith("#"):
        crate_name = line.split("=")[0].strip()
        ver_part = line.split("=")[1].strip()
        # Parse simple version string or table
        if ver_part.startswith('"'):
            crate_ver = ver_part.strip('"')
        elif "version" in ver_part:
            # extract version = "..."
            import re
            m = re.search(r'version\s*=\s*"([^"]+)"', ver_part)
            crate_ver = m.group(1) if m else "unknown"
        else:
            crate_ver = "unknown"

        components.append({
            "type": "library",
            "name": crate_name,
            "version": crate_ver,
            "scope": "required",
            "purl": f"pkg:cargo/{crate_name}@{crate_ver}"
        })

sbom = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.5",
    "serialNumber": serial_number,
    "version": 1,
    "metadata": {
        "timestamp": timestamp,
        "tools": [
            {
                "vendor": "Nexus",
                "name": "nexus-sbom-generator",
                "version": "1.2.1"
            }
        ],
        "component": {
            "type": "application",
            "name": "nexus-code",
            "version": "1.2.1",
            "properties": [
                {"name": "git:commit", "value": git_commit},
                {"name": "architecture", "value": "x86_64-linux"}
            ]
        }
    },
    "components": components
}

sbom_path = os.path.join(out_dir, "sbom.json")
with open(sbom_path, "w", encoding="utf-8") as f:
    json.dump(sbom, f, indent=2)

# Compute SHA-256
with open(sbom_path, "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()

checksum_path = os.path.join(out_dir, "sbom.json.sha256")
with open(checksum_path, "w", encoding="utf-8") as f:
    f.write(f"{digest}  sbom.json\n")

print(f"[+] SBOM successfully written to {sbom_path} (Components: {len(components)})")
print(f"[+] SHA-256: {digest}")
EOF

echo "[+] Software Bill of Materials (SBOM) generation complete."
