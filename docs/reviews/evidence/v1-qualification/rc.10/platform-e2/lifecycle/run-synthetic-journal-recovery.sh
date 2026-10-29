#!/usr/bin/env bash
# RC10 E2: recovery from synthetic upgrade-journal states (no real crash).
# Covers early transaction states (staged/preparing) and a malformed journal.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
log="$here/../ubuntu-22-04-node22-synthetic-journal-recovery.log"
[ -f /tmp/nexus-install.sh ] || { echo "missing installer at /tmp/nexus-install.sh" >&2; exit 2; }
[ "$(sha256sum /tmp/nexus-install.sh | awk '{print $1}')" = "5620d56ef6f8d637fc102ae2c8ea3b055effbc4069243a2df68b67520b1e2302" ] || { echo "installer hash mismatch" >&2; exit 2; }
docker run --rm --pull=never --network bridge \
  --mount "type=bind,src=/tmp/nexus-install.sh,dst=/tmp/nexus-install.sh,readonly" \
  nexus-e2/ubuntu-22-04-node22:prep-182e8addeee0 sh -ec '
  set -eu
  export PATH="$HOME/.local/bin:$PATH"
  NEXUS_VERSION=v1.0.0-rc.10 NEXUS_VERIFY_ATTESTATION=0 sh /tmp/nexus-install.sh >/tmp/install.log 2>&1
  test "$(nexus --version)" = "1.0.0-rc.10 (16ee8ca36438)"
  prefix="$HOME/.local"; lib="$prefix/lib/nexus"; journal="$lib/.upgrade-journal.json"; staging="$lib/.tmp-upgrade-synthetic"
  link=$(readlink -f "$prefix/bin/nexus")

  write_journal() {
    STATE="$1" STAGING="$2" node -e "
      const fs=require(\"node:fs\"),path=require(\"node:path\");
      const prefix=process.env.HOME+\"/.local\", lib=path.join(prefix,\"lib\",\"nexus\");
      const j={formatVersion:1,id:\"synthetic-\"+process.env.STATE,state:process.env.STATE,
        sourceVersion:\"v1.0.0-rc.10\",sourceInstallDir:path.join(lib,\"v1.0.0-rc.10\"),
        sourceSymlinkTarget:path.join(lib,\"v1.0.0-rc.10\",\"bin\",\"nexus\"),
        targetVersion:\"v1.0.0-rc.99\",targetInstallDir:path.join(lib,\"v1.0.0-rc.99\"),
        prefix,binPath:path.join(prefix,\"bin\",\"nexus\"),
        startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      if(process.env.STAGING===\"1\"){const s=path.join(lib,\".tmp-upgrade-synthetic\");fs.mkdirSync(s,{recursive:true});fs.writeFileSync(path.join(s,\"staged.txt\"),\"x\");j.stagingDir=s;}
      fs.writeFileSync(path.join(lib,\".upgrade-journal.json\"),JSON.stringify(j,null,2));
    " >/dev/null
  }
  unchanged() {
    test "$(nexus --version)" = "1.0.0-rc.10 (16ee8ca36438)"
    test "$(readlink -f "$prefix/bin/nexus")" = "$link"
    test ! -e "$lib/v1.0.0-rc.99"
  }

  echo "== staged journal with staging directory"
  write_journal staged 1
  test -d "$staging"
  nexus upgrade --recover >/tmp/r1.log 2>&1
  cat /tmp/r1.log
  grep -F "Recovery completed (cleaned_up)" /tmp/r1.log >/dev/null
  test ! -e "$staging"
  test "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"$journal\",\"utf8\")).state)")" = "rolled_back"
  unchanged
  nexus upgrade --recover >/tmp/r1b.log 2>&1
  cat /tmp/r1b.log
  grep -F "No interrupted upgrade found" /tmp/r1b.log >/dev/null

  echo "== preparing journal without staging"
  write_journal preparing 0
  nexus upgrade --recover >/tmp/r2.log 2>&1
  cat /tmp/r2.log
  grep -F "Recovery completed (cleaned_up)" /tmp/r2.log >/dev/null
  unchanged

  echo "== malformed journal is refused, installation untouched"
  printf "{\"formatVersion\":1" > "$journal"
  set +e
  nexus upgrade --recover >/tmp/r3.log 2>&1
  rc=$?
  set -e
  cat /tmp/r3.log
  test "$rc" -ne 0
  grep -F "failed schema or path validation" /tmp/r3.log >/dev/null
  test -f "$journal"
  unchanged
  echo "synthetic_journal_recovery=PASS staged_cleaned=true preparing_cleaned=true malformed_refused=true installation_unchanged=true"
  ' > "$log" 2>&1
cat "$log"
