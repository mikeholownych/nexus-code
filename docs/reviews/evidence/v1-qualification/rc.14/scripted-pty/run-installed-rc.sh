#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
out_dir=${1:?usage: run-installed-rc.sh NEW_ATTEMPT_DIRECTORY}
: "${NEXUS_PREFIX:?set NEXUS_PREFIX to the disposable installation prefix}"
: "${NEXUS_NODE_PATH:?set NEXUS_NODE_PATH to a directory containing Node.js >= 22}"
: "${PTY_PYTHON_PATH:?set PTY_PYTHON_PATH to the pinned pyte/wcwidth target directory}"

version=v1.0.0-rc.14
install_root="$NEXUS_PREFIX/lib/nexus/$version"
node_bin="$NEXUS_NODE_PATH/node"
expected="1.0.0-rc.14 (16eeb6eeffe7)"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/nexus-rc14-pty-run.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/logs" "$tmp/version-home"
actual=$(HOME="$tmp/version-home" PATH="$NEXUS_NODE_PATH:$NEXUS_PREFIX/bin:/usr/bin:/bin" "$NEXUS_PREFIX/bin/nexus" --version)
test "$actual" = "$expected" || { echo "wrong installed artifact: $actual" >&2; exit 2; }
test -x "$install_root/lib/core/nexus-tui"
test -f "$install_root/lib/cli/dist/sidecar.js"
test -f "$install_root/lib/cli/dist/index.js"
"$node_bin" --version | awk -F. '{major=$1; sub(/^v/,"",major); if (major+0 < 22) exit 1}'

if test -e "$out_dir"; then
  echo "refusing to overwrite existing attempt: $out_dir" >&2
  exit 2
fi
mkdir -p "$out_dir"

src="$repo_root/docs/v1.0.0/evidence/D_pty"
files=(ptylib.py mockgw.py s1_startup.py s2_approval.py s3_complete.py s4_cancel.py s5_ctrlc.py s6_steer_cancel.py s6n.py s7_resume.py s8_cancel_tool.py s9_quit_tool.py r1_repl.py r1d.py)
for file in "${files[@]}"; do cp -- "$src/$file" "$tmp/$file"; done

python3 - "$tmp/ptylib.py" "$tmp" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
text = path.read_text()
old = '''TUI = REPO + "/core/target/release/nexus-tui"
SIDECAR = REPO + "/cli/dist/sidecar.js"
INDEX = REPO + "/cli/dist/index.js"'''
new = '''TUI = os.environ["NEXUS_PTY_TUI"]
SIDECAR = os.environ["NEXUS_PTY_SIDECAR"]
INDEX = os.environ["NEXUS_PTY_INDEX"]'''
if text.count(old) != 1:
    raise SystemExit("unexpected PTY helper path block; refusing to patch")
text = text.replace(old, new)
old = '''    subprocess.run("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", shell=True, cwd=ws)
    env = {'''
new = '''    subprocess.run("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", shell=True, cwd=ws)
    trust_dir = os.path.join(home, ".config", "nexus")
    os.makedirs(trust_dir, mode=0o700, exist_ok=True)
    trust_file = os.path.join(trust_dir, "trusted_workspaces.json")
    with open(trust_file, "w", encoding="utf-8") as f:
        json.dump({"trustedPaths": [os.path.realpath(ws)]}, f)
    os.chmod(trust_file, 0o600)
    env = {
        "NEXUS_HOME": os.environ["NEXUS_PTY_HOME"],'''
if text.count(old) != 1:
    raise SystemExit("unexpected fixture workspace block; refusing to seed trust")
path.write_text(text.replace(old, new))
PY

export PATH="$NEXUS_NODE_PATH:$NEXUS_PREFIX/bin:/usr/bin:/bin"
export PYTHONNOUSERSITE=1
export PYTHONPATH="$PTY_PYTHON_PATH"
export NEXUS_PTY_HOME="$install_root"
export NEXUS_PTY_TUI="$install_root/lib/core/nexus-tui"
export NEXUS_PTY_SIDECAR="$install_root/lib/cli/dist/sidecar.js"
export NEXUS_PTY_INDEX="$install_root/lib/cli/dist/index.js"

scenarios=(s1_startup.py s2_approval.py s3_complete.py s4_cancel.py s5_ctrlc.py s6_steer_cancel.py s6n.py s7_resume.py s8_cancel_tool.py s9_quit_tool.py r1_repl.py r1d.py)
for scenario in "${scenarios[@]}"; do
  name=${scenario%.py}
  rc=0
  (cd "$tmp" && python3 -S "$scenario") >"$tmp/logs/$name.stdout" 2>"$tmp/logs/$name.stderr" || rc=$?
  printf '%s\n' "$rc" >"$tmp/logs/$name.exit"
done

mkdir -p "$out_dir/runner-capture"
cp -a "$tmp/." "$out_dir/runner-capture/"
{
  printf 'artifact_version=%s\n' "$expected"
  printf 'archive_sha256=%s\n' '52d1c855158c63dbc7cac2e9d87e2f64b1feffb193de97660e92276a2bd46eb7'
  printf 'nexus_home=%s\n' "$install_root"
  printf 'node_version=%s\n' "$("$node_bin" --version)"
  printf 'python_version=%s\n' "$(python3 --version)"
  printf 'source_commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD)"
  printf 'scenarios=%s\n' "${scenarios[*]}"
} >"$out_dir/runner-manifest.txt"
echo "Captured PTY scenarios in $out_dir; review each screen/stream and compare with ACCEPTANCE §5.2."
