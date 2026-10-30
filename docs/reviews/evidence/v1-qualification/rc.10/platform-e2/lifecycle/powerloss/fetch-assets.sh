#!/usr/bin/env bash
# Fetch the published assets the power-loss cell needs and verify them with the
# release's own SHA256SUMS. Usage: fetch-assets.sh [dir] [tag ...]
set -euo pipefail
assets="${1:-/var/tmp/nexus-powerloss-assets}"
shift || true
if [ "$#" -gt 0 ]; then tags="$*"; else tags="v1.0.0-rc.9 v1.0.0-rc.10"; fi
repo="mikeholownych/nexus-code"
for tag in $tags; do
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
  mkdir -p "$assets/$tag"
  gh release download "$tag" -R "$repo" \
    -p "nexus-linux-x86_64-$tag.tar.gz" \
    -p "SHA256SUMS" -p "compatibility.json" \
    -D "$assets/$tag" --clobber
  (cd "$assets/$tag" && sha256sum -c SHA256SUMS --ignore-missing)
done
echo "assets ready in $assets"
