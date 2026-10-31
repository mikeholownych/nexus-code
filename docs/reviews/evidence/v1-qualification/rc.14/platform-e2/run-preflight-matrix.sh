#!/usr/bin/env bash
# RC14 E2 negative prerequisite cases; no qualification corpus or product code is used.
set -u
assets_dir=${1:?usage: run-preflight-matrix.sh ASSETS_DIR OUTPUT_DIR}
out_root=${2:?usage: run-preflight-matrix.sh ASSETS_DIR OUTPUT_DIR}
installer="$assets_dir/install.sh"
[ -f "$installer" ] || { echo "missing release installer: $installer" >&2; exit 2; }
mkdir -p "$out_root"
failures=0
for platform in ubuntu-22-04 ubuntu-24-04 debian-12 fedora-40; do
  for runtime in nodenone node12 node20; do
    cell="${platform}-${runtime}"
    out="$out_root/$cell"
    mkdir -p "$out"
    image="nexus-e2/${cell}:prep-182e8addeee0"
    if docker run --rm --pull=never --network none --entrypoint /bin/sh \
      -v "$installer:/mnt/install.sh:ro" "$image" -c '
        set -eu
        mkdir -p "$HOME/.local"
        printf marker >"$HOME/operator-marker"
        snapshot(){ (cd "$HOME"; find . -mindepth 1 -printf "%P %y %m\\n" | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum); }
        before=$(snapshot | sha256sum)
        export NEXUS_VERSION=v1.0.0-rc.14 NEXUS_VERIFY_ATTESTATION=auto
        set +e
        sh /mnt/install.sh >/tmp/install.out 2>/tmp/install.err
        install_rc=$?
        set -e
        after=$(snapshot | sha256sum)
        test "$before" = "$after"
        test "$install_rc" -ne 0
        grep -q "Node.js 22 or newer is required" /tmp/install.err
        echo "E2_PREREQUISITE_REFUSAL_PASS node=$(node --version 2>/dev/null || echo absent) exit=$install_rc HOME_tree_and_files_unchanged=true network=none"
        cat /tmp/install.err
      ' >"$out/stdout.log" 2>"$out/stderr.log"; then
      rc=0
    else
      rc=$?
      failures=$((failures+1))
    fi
    printf 'docker_exit=%s\n' "$rc" >"$out/exit.txt"
    echo "$cell docker_exit=$rc"
  done
done
[ "$failures" -eq 0 ]
