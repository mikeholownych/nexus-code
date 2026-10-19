#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/scope-procs.sh"
tmp="$(mktemp -d)"
cleanup() { python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/bin" "$tmp/cgroup/user.slice/test.scope"

cat > "$tmp/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${SYSTEMCTL_FAIL:-0}" == 1 ]] && exit 1
property=""
for arg in "$@"; do
  case "$arg" in
    --property=*) property="${arg#--property=}" ;;
  esac
done
cat "${FIXTURE_STATE_DIR:?}/$property"
STUB
chmod +x "$tmp/bin/systemctl"
PATH="$tmp/bin:$PATH"
export PATH FIXTURE_STATE_DIR="$tmp/state" NEXUS_CGROUP_ROOT="$tmp/cgroup"
mkdir -p "$FIXTURE_STATE_DIR"

set_state() {
  printf '%s\n' "$1" > "$FIXTURE_STATE_DIR/LoadState"
  printf '%s\n' "$2" > "$FIXTURE_STATE_DIR/ActiveState"
  printf '%s\n' "$3" > "$FIXTURE_STATE_DIR/ControlGroup"
}
expect_count() {
  local want="$1" got
  got="$(nexus_terminal_scope_procs test)"
  [[ "$got" == "$want" ]] || { echo "expected $want processes, got $got" >&2; exit 1; }
}
expect_unavailable() {
  if nexus_terminal_scope_procs test >/dev/null 2>&1; then
    echo "expected unavailable measurement to fail closed" >&2
    exit 1
  fi
}

set_state loaded active /user.slice/test.scope
: > "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_count 0
printf '101\n202\n' > "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_count 2

python3 -c 'import os,sys; os.unlink(sys.argv[1])' "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_unavailable
: > "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
chmod 000 "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_unavailable
chmod 600 "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
printf 'not-a-pid\n' > "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_unavailable
python3 -c 'import os,sys; os.unlink(sys.argv[1])' "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
mkdir "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"
expect_unavailable
python3 -c 'import os,sys; os.rmdir(sys.argv[1])' "$NEXUS_CGROUP_ROOT/user.slice/test.scope/cgroup.procs"

set_state loaded inactive ''
expect_count 0
set_state not-found inactive ''
expect_count 0

set_state loaded active ''
expect_unavailable
set_state loaded active /user.slice/../escape
expect_unavailable
set_state loaded active /user.slice/test.scope
SYSTEMCTL_FAIL=1 expect_unavailable

mkdir -p "$tmp/evidence"
write_evidence_fixture() {
  MODE="$1" EVIDENCE_DIR="$tmp/evidence" node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.EVIDENCE_DIR;
const sha = (data) => createHash("sha256").update(data).digest("hex");
for (const [name, body] of Object.entries({
  "approval.png": "approval screenshot",
  "post-exit.png": "post exit screenshot",
  "mock.log": "mock request log",
  "answers.tsv": "checks",
  "exits.tsv": "measurements",
})) fs.writeFileSync(path.join(dir, name), body);
const files = Object.fromEntries(Object.entries({
  approvalScreenshot: "approval.png",
  postExitScreenshot: "post-exit.png",
  mockLog: "mock.log",
  answers: "answers.tsv",
  exits: "exits.tsv",
}).map(([key, name]) => [key, { path: name, sha256: sha(fs.readFileSync(path.join(dir, name))) }]));
for (const terminal of ["xterm", "kitty", "tmux-gnome", "vscode", "gnome"]) {
  for (const size of ["80x24", "40x14", "200x60"]) {
    const cell = `${terminal}-${size}`;
    const measurement = (launch) => ({
      launch,
      exitStatus: 0,
      sttyRestored: true,
      survivors: 0,
      scopeMeasurement: process.env.MODE === "unavailable" && cell === "xterm-80x24" && launch === "main" ? "unavailable" : "verified",
      at: "2026-10-19T00:00:00Z",
    });
    const record = {
      cell,
      attempt: 1,
      rc: "v1.0.0-rc.1",
      packageManifestSha256: "a".repeat(64),
      measured: [measurement("main"), measurement("no_color")],
      scenarios: { approveToolRounds: [0, 1], stream: 1, sleepTool: 1 },
      checks: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((check) => [check, { result: "PASS", note: "" }])),
      files,
    };
    const output = `${JSON.stringify(record, null, 2)}\n`;
    const file = path.join(dir, `cell-${cell}.attempt-1.json`);
    fs.writeFileSync(file, output);
    fs.writeFileSync(`${file}.sha256`, `${sha(output)}  ${path.basename(file)}\n`);
  }
}
NODE
}
write_evidence_fixture unavailable
if node "$HERE/summarize.mjs" "$tmp/evidence" --rc v1.0.0-rc.1 --manifest-sha256 "$(printf 'a%.0s' {1..64})" > "$tmp/unavailable-summary.log" 2>&1; then
  echo "summary gate accepted an unavailable process-scope measurement" >&2
  exit 1
fi
grep -q 'safety check 5 FAIL (scope measurement unavailable)' "$tmp/unavailable-summary.log"
write_evidence_fixture verified
node "$HERE/summarize.mjs" "$tmp/evidence" --rc v1.0.0-rc.1 --manifest-sha256 "$(printf 'a%.0s' {1..64})" > "$tmp/verified-summary.log"
grep -q 'manual matrix gate for v1.0.0-rc.1 .*: PASS' "$tmp/verified-summary.log"

echo "scope measurement fixtures passed"
