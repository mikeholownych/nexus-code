#!/usr/bin/env bash
set -u
assets_dir=${1:?usage: run-node22-matrix.sh ASSETS_DIR OUTPUT_DIR}
out_root=${2:?usage: run-node22-matrix.sh ASSETS_DIR OUTPUT_DIR}
installer="$assets_dir/install.sh"
mkdir -p "$out_root"
failures=0
for platform in ubuntu-22-04 ubuntu-24-04 debian-12 fedora-40; do
  out="$out_root/$platform"
  mkdir -p "$out"
  chmod 0777 "$out"
  image="nexus-e2/${platform}-node22:prep-182e8addeee0"
  if docker run --rm --pull=never --entrypoint /bin/sh -v "$installer:/mnt/install.sh:ro" -v "$out:/evidence:rw" "$image" -c '
    set -eu
    test "$(node --version)" = v22.23.3
    export NEXUS_VERSION=v1.0.0-rc.14 NEXUS_VERIFY_ATTESTATION=auto
    sh /mnt/install.sh
    export PATH="$HOME/.local/bin:$PATH"
    version=$(nexus --version)
    printf "launcher_version=%s\\n" "$version"
    test "$version" = "1.0.0-rc.14 (16eeb6eeffe7)"
    set +e
    nexus doctor --json >/evidence/doctor.json 2>/evidence/doctor.err
    doctor_rc=$?
    set -e
    test ! -s /evidence/doctor.err
    node -e "const fs=require(\"node:fs\");const d=JSON.parse(fs.readFileSync(\"/evidence/doctor.json\",\"utf8\"));if(d.nexusVersion!==\"1.0.0-rc.14\")process.exit(1);const f=d.findings||[];for(const id of [\"install.build\",\"engine.binary\"]){const x=f.find(y=>y.id===id);if(!x||x.status!==\"pass\")process.exit(2)}if(f.some(x=>/version/i.test(x.id+\" \"+x.explanation)&&[\"warn\",\"fail\"].includes(x.status)))process.exit(3);"
    echo "doctor_exit=$doctor_rc"
    echo "E2_FRESH_INSTALL_PASS node=$(node --version) stderr_bytes=0 no_version_warning=true"
  ' >"$out/stdout.log" 2>"$out/stderr.log"; then rc=0; else rc=$?; failures=$((failures+1)); fi
  printf 'docker_exit=%s\n' "$rc" >"$out/exit.txt"
  echo "$platform docker_exit=$rc"
done
[ "$failures" -eq 0 ]
