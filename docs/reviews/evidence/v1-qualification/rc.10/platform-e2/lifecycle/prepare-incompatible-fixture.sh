#!/usr/bin/env bash
set -euo pipefail
archive=$1; out=$2
expected=444d0812ad583b7f688890ac8536cb872e92364c977d9fbf298fa0408d98b3e7
[ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected" ] || { echo "RC10 archive digest mismatch" >&2; exit 1; }
[ ! -e "$out" ] || { echo "output exists" >&2; exit 1; }
mkdir -p "$out/release/pkg"
tar -xzf "$archive" -C "$out/release/pkg"
node -e '
const fs=require("fs"), p=process.argv[1];
const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.version="1.0.0-rc.4"; c.revision="1".repeat(40); c.builtAt="2026-10-01T00:00:00Z";
c.components={cli:"1.0.0-rc.4",core:"1.0.0-rc.4",tui:"1.0.0-rc.4",harness:"1.0.0-rc.4"};
c.compatibility={configSchemaVersion:1,stateSchemaVersion:1,minSupportedConfigVersion:1,minSupportedStateVersion:0};
c.platforms={"linux-x86_64":{archive:"nexus-linux-x86_64-v1.0.0-rc.4.tar.gz",os:"linux",arch:"x86_64",libc:"glibc-2.35"}};
fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
' "$out/release/pkg/nexus/compatibility.json"
printf 'v1.0.0-rc.4\n' > "$out/release/pkg/nexus/VERSION"
(cd "$out/release/pkg/nexus" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
mkdir -p "$out/release/download/v1.0.0-rc.4"
(cd "$out/release/pkg" && tar --sort=name --mtime="2026-10-01 00:00:00 UTC" --owner=0 --group=0 --numeric-owner -czf "$out/release/download/v1.0.0-rc.4/nexus-linux-x86_64-v1.0.0-rc.4.tar.gz" nexus)
archive_sha=$(sha256sum "$out/release/download/v1.0.0-rc.4/nexus-linux-x86_64-v1.0.0-rc.4.tar.gz" | awk "{print \$1}")
node -e '
const fs=require("fs"), p=process.argv[1], sha=process.argv[2];
const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.platforms["linux-x86_64"].sha256=sha;
fs.writeFileSync(process.argv[3], JSON.stringify(c,null,2)+"\n");
' "$out/release/pkg/nexus/compatibility.json" "$archive_sha" "$out/release/download/v1.0.0-rc.4/compatibility.json"
(cd "$out/release/download/v1.0.0-rc.4" && sha256sum nexus-linux-x86_64-v1.0.0-rc.4.tar.gz compatibility.json > SHA256SUMS)
node -e '
const fs=require("fs"), d=process.argv[1];
const names=["nexus-linux-x86_64-v1.0.0-rc.4.tar.gz","SHA256SUMS","compatibility.json"];
const base="http://127.0.0.1:PORT/download/v1.0.0-rc.4/";
fs.writeFileSync(d+"/api.json", JSON.stringify({tag_name:"v1.0.0-rc.4",name:"synthetic",draft:false,prerelease:true,published_at:"2026-10-01T00:00:00Z",html_url:"http://127.0.0.1:PORT",assets:names.map(n=>({name:n,browser_download_url:base+n,size:fs.statSync(d+"/download/v1.0.0-rc.4/"+n).size}))},null,2));
' "$out/release"
rm -rf "$out/release/pkg"
echo "fixture=$out/release"
