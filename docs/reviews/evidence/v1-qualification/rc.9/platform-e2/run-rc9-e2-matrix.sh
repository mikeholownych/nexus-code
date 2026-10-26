#!/usr/bin/env bash
set -euo pipefail
root=/var/tmp/nexus-rc9-e2-4cae11c
installer=/home/mike/nexus-wt/rc9-credential-origin-binding/install.sh
platforms=(ubuntu-22-04 ubuntu-24-04 debian-12 fedora-40)
for platform in "${platforms[@]}"; do
  for runtime in nodenone node12 node20; do
    image="nexus-e2/${platform}-${runtime}:prep-182e8addeee0"
    log="$root/${platform}-${runtime}.log"
    echo "START ${platform} ${runtime} $(date -u +%FT%TZ)"
    docker run --rm --pull=never --network none \
      --mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly" \
      --env NEXUS_VERSION=v1.0.0-rc.9 "$image" sh -ec '
        before=$(find "$HOME" -mindepth 1 -printf "%P %y\\n" | sort | sha256sum | cut -d" " -f1)
        if output=$(NEXUS_VERSION=v1.0.0-rc.9 sh /tmp/nexus-install.sh 2>&1); then
          echo "unexpected installer success"; exit 40
        fi
        printf "%s\\n" "$output"
        printf "%s" "$output" | grep -F "Node.js 22 or newer is required" >/dev/null
        after=$(find "$HOME" -mindepth 1 -printf "%P %y\\n" | sort | sha256sum | cut -d" " -f1)
        test "$before" = "$after"
        echo "preflight=PASS home_unchanged=true"
      ' > "$log" 2>&1
    echo "PASS ${platform} ${runtime}"
  done
  for runtime in node22 node24; do
    base_runtime=$runtime
    if [ "$runtime" = node24 ]; then base_runtime=node22; fi
    image="nexus-e2/${platform}-${base_runtime}:prep-182e8addeee0"
    log="$root/${platform}-${runtime}.log"
    echo "START ${platform} ${runtime} $(date -u +%FT%TZ)"
    mounts=(--mount "type=bind,src=$installer,dst=/tmp/nexus-install.sh,readonly")
    if [ "$runtime" = node24 ]; then mounts+=(--mount "type=bind,src=/home/mike/.local/node-v24.11.1-linux-x64,dst=/opt/node24,readonly"); fi
    docker run --rm --pull=never --network bridge "${mounts[@]}" \
      --env NEXUS_VERSION=v1.0.0-rc.9 "$image" sh -ec '
        if [ -x /opt/node24/bin/node ]; then export PATH="/opt/node24/bin:$PATH"; fi
        id
        node --version
        expected='"${runtime#node}"'
        major=$(node --version | cut -d. -f1 | tr -d v)
        test "$major" = "$expected"
        NEXUS_VERSION=v1.0.0-rc.9 sh /tmp/nexus-install.sh
        export PATH="$HOME/.local/bin:$PATH"
        version=$(nexus --version)
        printf "launcher_version=%s\\n" "$version"
        test "$version" = "1.0.0-rc.9 (4cae11cbc3b0)"
        nexus doctor --json >/tmp/doctor.json 2>/tmp/doctor.err || doctor_rc=$?
        doctor_rc=${doctor_rc:-0}
        printf "doctor_rc=%s doctor_stderr_bytes=%s\\n" "$doctor_rc" "$(wc -c </tmp/doctor.err)"
        test ! -s /tmp/doctor.err
        node -e '\''const fs=require("fs");const d=JSON.parse(fs.readFileSync("/tmp/doctor.json","utf8"));if(d.nexusVersion!=="1.0.0-rc.9")process.exit(1);const f=d.findings||[];for(const id of ["install.build","engine.binary"]){const x=f.find(y=>y.id===id);if(!x||x.status!=="pass")process.exit(2)}if(f.some(x=>/version/i.test(x.id+" "+x.explanation)&&["warn","fail"].includes(x.status)))process.exit(3);'\''
        grep -E "\"id\": \"(install.build|engine.binary)\"|\"status\": \"(pass|warn|fail)\"" /tmp/doctor.json | head -20
      ' > "$log" 2>&1
    echo "PASS ${platform} ${runtime}"
  done
done
