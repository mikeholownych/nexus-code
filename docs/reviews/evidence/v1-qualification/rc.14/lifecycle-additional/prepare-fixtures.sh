#!/usr/bin/env bash
# Build the tampered-checksum fixture for the RC14 checksum cell from the exact
# published archive. The index is replaced with an all-zero digest, so the
# installer must refuse before it touches an installation.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <published-rc14-archive> <new-output-directory>" >&2
  exit 2
fi
archive=$1
out=$2
expected=52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7
[ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected" ] || { echo "RC14 archive digest mismatch" >&2; exit 1; }
[ ! -e "$out" ] || { echo "output directory already exists; refusing to overwrite" >&2; exit 1; }
mkdir -p "$out/tampered-release/fixture/download/v1.0.0-rc.14"
cp "$archive" "$out/tampered-release/fixture/download/v1.0.0-rc.14/nexus-linux-x86_64-v1.0.0-rc.14.tar.gz"
printf '%064d  nexus-linux-x86_64-v1.0.0-rc.14.tar.gz\n' 0 > "$out/tampered-release/fixture/download/v1.0.0-rc.14/SHA256SUMS"
echo "fixture=$out/tampered-release/fixture"
