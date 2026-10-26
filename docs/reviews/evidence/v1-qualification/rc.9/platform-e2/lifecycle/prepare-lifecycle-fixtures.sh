#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <workflow-produced-rc9-archive> <new-output-directory>" >&2
  exit 2
fi
archive=$1
out=$2
expected=35795d2b7639b68a541c512976d8bc7f251115ebdccf48f6b9cf5f98ef1af9bb
actual=$(sha256sum "$archive" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo "RC9 archive digest mismatch" >&2; exit 1; }
[ ! -e "$out" ] || { echo "output directory already exists; refusing to overwrite" >&2; exit 1; }
mkdir -p "$out"

make_base() {
  local target=$1
  mkdir -p "$target/pkg"
  tar -xzf "$archive" -C "$target/pkg"
}

make_base "$out/tampered-release"
mkdir -p "$out/tampered-release/fixture/download/v1.0.0-rc.9"
cp "$archive" "$out/tampered-release/fixture/download/v1.0.0-rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz"
printf '%064d  nexus-linux-x86_64-v1.0.0-rc.9.tar.gz\n' 0 > "$out/tampered-release/fixture/download/v1.0.0-rc.9/SHA256SUMS"
rm -rf "$out/tampered-release/pkg"

make_base "$out/broken-release"
printf 'process.stdout.write("9.9.9\\n");\n' > "$out/broken-release/pkg/nexus/lib/cli/dist/index.js"
(cd "$out/broken-release/pkg/nexus" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
mkdir -p "$out/broken-release/fixture/download/v1.0.0-rc.9"
(cd "$out/broken-release/pkg" && tar -czf "$out/broken-release/fixture/download/v1.0.0-rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz" nexus)
(cd "$out/broken-release/fixture/download/v1.0.0-rc.9" && sha256sum nexus-linux-x86_64-v1.0.0-rc.9.tar.gz > SHA256SUMS)
printf '%s\n' "$(sha256sum "$out/broken-release/pkg/nexus/lib/cli/dist/index.js")" > "$out/broken-release/broken-index.sha256"
rm -rf "$out/broken-release/pkg"

make_base "$out/process-crash-release"
cp "$out/process-crash-release/pkg/nexus/lib/cli/dist/index.js" "$out/process-crash-release/pkg/nexus/lib/cli/dist/index.real.js"
printf 'if (process.argv.includes("--version") && (process.env.NEXUS_HOME || "").endsWith("/lib/nexus/v1.0.0-rc.9")) {\n  setTimeout(() => import("./index.real.js"), 60000);\n} else {\n  import("./index.real.js");\n}\n' > "$out/process-crash-release/pkg/nexus/lib/cli/dist/index.js"
printf '%s\n' "$(sha256sum "$out/process-crash-release/pkg/nexus/lib/cli/dist/index.js")" > "$out/process-crash-release/broken-index.sha256"
printf '%s\n' "$(sha256sum "$out/process-crash-release/pkg/nexus/lib/cli/dist/index.real.js")" > "$out/process-crash-release/original-index.sha256"
(cd "$out/process-crash-release/pkg/nexus" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
mkdir -p "$out/process-crash-release/fixture/download/v1.0.0-rc.9"
(cd "$out/process-crash-release/pkg" && tar -czf "$out/process-crash-release/fixture/download/v1.0.0-rc.9/nexus-linux-x86_64-v1.0.0-rc.9.tar.gz" nexus)
(cd "$out/process-crash-release/fixture/download/v1.0.0-rc.9" && sha256sum nexus-linux-x86_64-v1.0.0-rc.9.tar.gz > SHA256SUMS)
rm -rf "$out/process-crash-release/pkg"
