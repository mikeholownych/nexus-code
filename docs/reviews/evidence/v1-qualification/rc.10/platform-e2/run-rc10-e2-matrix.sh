#!/usr/bin/env bash
# RC10 E2 matrix: negative Node preflight cells and fresh-install/doctor cells
# across the prepared Ubuntu 22.04/24.04, Debian 12 and Fedora 40 images.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
installer=/tmp/nexus-install.sh
version=v1.0.0-rc.10
expected_version="1.0.0-rc.10 (16ee8ca36438)"
installer_sha=5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302
node24=/home/mike/.local/node-v24.11.1-linux-x64
doctor_dir=/tmp/opencode/e2-doctor
mkdir -p "$doctor_dir"
rm -f "$doctor_dir"/*.doctor.json
chmod 0777 "$doctor_dir"
[ -f "$installer" ] || { echo "missing installer at $installer" >&2; exit 2; }
printf '%s  %s\n' "$installer_sha" "$installer" | sha256sum -c -
[ -x "$node24/bin/node" ] || { echo "missing Node 24 runtime at $node24" >&2; exit 2; }

platforms=(ubuntu-22-04 ubuntu-24-04 debian-12 fedora-40)
negative_runtimes=(nodenone node12 node20)
positive_runtimes=(node22 node24)
failures=0
results="$here/results.tsv"
: > "$results"
printf 'cell\tkind\tresult\n' >> "$results"

record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$results"; }

for platform in "${platforms[@]}"; do
  for runtime in "${negative_runtimes[@]}"; do
    image="nexus-e2/${platform}-${runtime}:prep-182e8addeee0"
    log="$here/${platform}-${runtime}.log"
    echo "START ${platform} ${runtime} $(date -u +%FT%TZ)"
    if docker run --rm --pull=never --network none \
      --mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly" \
      --env NEXUS_VERSION="$version" "$image" sh -ec '
        before=$(find "$HOME" -mindepth 1 -printf "%P %y\n" | sort | sha256sum | cut -d" " -f1)
        if output=$(NEXUS_VERSION="$NEXUS_VERSION" sh /tmp/nexus-install.sh 2>&1); then
          echo "unexpected installer success"; exit 40
        fi
        printf "%s\n" "$output"
        printf "%s" "$output" | grep -F "Node.js 22 or newer is required" >/dev/null
        after=$(find "$HOME" -mindepth 1 -printf "%P %y\n" | sort | sha256sum | cut -d" " -f1)
        test "$before" = "$after"
        echo "preflight=PASS home_unchanged=true"
      ' > "$log" 2>&1; then
      echo "PASS ${platform} ${runtime}"; record "${platform}-${runtime}" negative PASS
    else
      echo "FAIL ${platform} ${runtime}"; record "${platform}-${runtime}" negative FAIL; failures=$((failures+1))
    fi
  done

  for runtime in "${positive_runtimes[@]}"; do
    base_runtime=$runtime
    [ "$runtime" = node24 ] && base_runtime=node22
    image="nexus-e2/${platform}-${base_runtime}:prep-182e8addeee0"
    log="$here/${platform}-${runtime}.log"
    mounts=(--mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly" --mount "type=bind,src=$doctor_dir,dst=/evidence")
    [ "$runtime" = node24 ] && mounts+=(--mount "type=bind,src=$node24,dst=/opt/node24,readonly")
    echo "START ${platform} ${runtime} $(date -u +%FT%TZ)"
    if docker run --rm --pull=never --network bridge "${mounts[@]}" \
      --env NEXUS_VERSION="$version" --env NEXUS_CELL="${platform}-${runtime}" "$image" sh -ec '
        if [ -x /opt/node24/bin/node ]; then export PATH="/opt/node24/bin:$PATH"; fi
        id
        node --version
        expected='"${runtime#node}"'
        major=$(node --version | cut -d. -f1 | tr -d v)
        test "$major" = "$expected"
        NEXUS_VERIFY_ATTESTATION=0 NEXUS_VERSION="$NEXUS_VERSION" sh /tmp/nexus-install.sh
        export PATH="$HOME/.local/bin:$PATH"
        version=$(nexus --version)
        printf "launcher_version=%s\n" "$version"
        test "$version" = "'"$expected_version"'"
        nexus doctor --json >/tmp/doctor.json 2>/tmp/doctor.err || doctor_rc=$?
        doctor_rc=${doctor_rc:-0}
        printf "doctor_rc=%s doctor_stderr_bytes=%s\n" "$doctor_rc" "$(wc -c </tmp/doctor.err)"
        cp /tmp/doctor.json "/evidence/${NEXUS_CELL}.doctor.json"
        test ! -s /tmp/doctor.err
        node -e '\''const fs=require("fs");const d=JSON.parse(fs.readFileSync("/tmp/doctor.json","utf8"));if(d.nexusVersion!=="'"${expected_version%% *}"'")process.exit(1);const f=d.findings||[];for(const id of ["install.build","engine.binary"]){const x=f.find(y=>y.id===id);if(!x||x.status!=="pass")process.exit(2)}if(f.some(x=>/version/i.test(x.id+" "+x.explanation)&&["warn","fail"].includes(x.status)))process.exit(3);'\''
        node -e '\''const d=require("/tmp/doctor.json");for(const f of d.findings||[])console.log(f.status+"\t"+f.id+"\t"+f.explanation);'\''
      ' > "$log" 2>&1; then
      echo "PASS ${platform} ${runtime}"; record "${platform}-${runtime}" positive PASS
    else
      echo "FAIL ${platform} ${runtime}"; record "${platform}-${runtime}" positive FAIL; failures=$((failures+1))
    fi
  done
done

{
  printf '{\n  "tag": "%s",\n  "expectedVersion": "%s",\n  "installerSha256": "%s",\n  "generatedAt": "%s",\n  "images": [\n' "$version" "$expected_version" "$installer_sha" "$(date -u +%FT%TZ)"
  first=1
  for platform in "${platforms[@]}"; do
    for runtime in nodenone node12 node20 node22; do
      image="nexus-e2/${platform}-${runtime}:prep-182e8addeee0"
      id=$(docker image inspect --format '{{.Id}}' "$image")
      [ $first -eq 0 ] && printf ',\n'
      first=0
      printf '    {"cell": "%s-%s", "image": "%s", "id": "%s"}' "$platform" "$runtime" "$image" "$id"
    done
  done
  printf '\n  ]\n}\n'
} > "$here/prepared-images.json"

cp "$doctor_dir"/*.doctor.json "$here"/ 2>/dev/null || true
echo "failures=$failures"
exit $((failures > 0 ? 1 : 0))
