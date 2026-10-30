#!/usr/bin/env bash
# Fetch the published assets the power-loss cell needs and verify them against
# the pinned digests in run-power-loss-durability.sh.
set -euo pipefail
assets="${1:-/var/tmp/nexus-powerloss-assets}"
repo="mikeholownych/nexus-code"
mkdir -p "$assets/rc.9" "$assets/rc.10"
for v in 9 10; do
  gh release download "v1.0.0-rc.$v" -R "$repo" \
    -p "nexus-linux-x86_64-v1.0.0-rc.$v.tar.gz" \
    -p "SHA256SUMS" -p "compatibility.json" \
    -D "$assets/rc.$v" --clobber
  (cd "$assets/rc.$v" && sha256sum -c SHA256SUMS --ignore-missing)
done
echo "assets ready in $assets"
