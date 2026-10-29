#!/usr/bin/env bash
# One cell of the manual real-terminal matrix (ACCEPTANCE §5.3), run by a human INSIDE the terminal under test, sized
# to the cell. It verifies the installed RC package and the terminal, launches the TUI against a deterministic local
# mock from an isolated HOME and a whitelisted environment, and captures what can be measured:
#   - terminal state (stty) before and after each exit;
#   - processes from the cell (by HOME or workspace cwd) that survive an exit, with a planted positive control;
#   - the mock's request log, which proves which scenarios ran.
# The human records PASS/FAIL per check. Screenshots are optional under DEC-18; every attempt is kept. Usage:
#   scripts/terminal-acceptance/run-cell.sh --rc v1.0.0-rc.N --terminal <xterm|kitty|tmux-gnome|vscode|gnome> \
#     --size <80x24|40x14|200x60> --out <evidence dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
source "$HERE/scope-procs.sh"
rc="" terminal="" size="" out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rc) rc="$2"; shift 2 ;;
    --terminal) terminal="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$rc" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]] || { echo "--rc must be an RC tag, vX.Y.Z-rc.N" >&2; exit 2; }
[[ "$terminal" =~ ^(xterm|kitty|tmux-gnome|vscode|gnome)$ ]] || { echo "--terminal must be xterm|kitty|tmux-gnome|vscode|gnome" >&2; exit 2; }
[[ "$size" =~ ^(80x24|40x14|200x60)$ ]] || { echo "--size must be 80x24|40x14|200x60" >&2; exit 2; }
[[ -n "$out" ]] || { echo "--out is required" >&2; exit 2; }
[[ -t 0 && -t 1 ]] || { echo "run this interactively in the terminal under test" >&2; exit 2; }

# Identity: the installed RC package (VERSION and its own MANIFEST.sha256), never a checkout build.
nexus_bin="$(command -v nexus)" || { echo "nexus is not on PATH; install the RC with the documented one-line command" >&2; exit 2; }
nexus_real="$(readlink -f "$nexus_bin")"
package="$(dirname "$(dirname "$nexus_real")")"
[[ "$(cat "$package/VERSION" 2>/dev/null)" == "$rc" ]] || { echo "nexus resolves to $nexus_real, which is not an installed $rc package" >&2; exit 2; }
(cd "$package" && sha256sum --check --status MANIFEST.sha256) || { echo "installed package at $package fails its MANIFEST.sha256" >&2; exit 2; }
# The manifest must also list every file: an extra file in the package would pass sha256sum --check.
diff <(cd "$package" && find . -type f ! -name MANIFEST.sha256 | sed 's|^\./||' | LC_ALL=C sort) \
     <(sed -E 's/^[0-9a-f]{64} [ *]//; s|^\./||' "$package/MANIFEST.sha256" | LC_ALL=C sort) >/dev/null \
  || { echo "installed package at $package has files its MANIFEST.sha256 does not list" >&2; exit 2; }
manifest_sha="$(sha256sum "$package/MANIFEST.sha256" | cut -d' ' -f1)"
version_line="$(nexus --version 2>&1 | head -n 1)"
[[ "$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' <<< "$version_line" | head -n 1)" == "${rc#v}" ]] || { echo "nexus reports '$version_line', not exactly ${rc#v}" >&2; exit 2; }

# Terminal: the cell's size, and environment consistent with the claimed terminal.
want_cols="${size%x*}" want_rows="${size#*x}"
read -r rows cols < <(stty size)
[[ "$cols" == "$want_cols" && "$rows" == "$want_rows" ]] || { echo "terminal is ${cols}x${rows}; resize it to $size first" >&2; exit 2; }
tmux_version=""
case "$terminal" in
  xterm) [[ -n "${XTERM_VERSION:-}" && -z "${TMUX:-}" ]] || { echo "XTERM_VERSION unset or inside tmux: not xterm" >&2; exit 2; } ;;
  kitty) [[ -n "${KITTY_WINDOW_ID:-}" && -z "${TMUX:-}" ]] || { echo "KITTY_WINDOW_ID unset or inside tmux: not kitty" >&2; exit 2; } ;;
  vscode) [[ "${TERM_PROGRAM:-}" == vscode ]] || { echo "TERM_PROGRAM is not vscode" >&2; exit 2; } ;;
  gnome) [[ -n "${GNOME_TERMINAL_SCREEN:-}${GNOME_TERMINAL_SERVICE:-}" && -z "${TMUX:-}" ]] || { echo "GNOME_TERMINAL_SCREEN/SERVICE unset or inside tmux: not GNOME Terminal" >&2; exit 2; } ;;
  tmux-gnome)
    [[ -n "${TMUX:-}" && -n "${GNOME_TERMINAL_SCREEN:-}${GNOME_TERMINAL_SERVICE:-}" ]] || { echo "run inside tmux inside GNOME Terminal" >&2; exit 2; }
    tmux_version="$(tmux -V)"; [[ "$tmux_version" =~ ^tmux\ 3\. ]] || { echo "need tmux 3.x, have $tmux_version" >&2; exit 2; } ;;
esac
kitty_protocol=""
if [[ "$terminal" == kitty ]]; then
  read -r -p "Is the kitty keyboard protocol enabled for this window? (yes/no) " kitty_protocol
  [[ "$kitty_protocol" == yes ]] || { echo "enable the kitty keyboard protocol first" >&2; exit 2; }
fi

# The scope-based survivor check needs the user's systemd manager.
systemd-run --user --scope --quiet -- true || { echo "systemd user scopes are unavailable in this session" >&2; exit 2; }

# Attempts are numbered in one directory and never overwritten; the gate counts every attempt, including aborted ones.
cell="$terminal-$size"
mkdir -p "$out"
attempt=1
while [[ -e "$out/cell-$cell.attempt-$attempt.json" || -e "$out/cell-$cell.attempt-$attempt.partial" ]]; do attempt=$((attempt + 1)); done
stem="$out/cell-$cell.attempt-$attempt"
attempt_start="$(date +%s)"
: > "$stem.partial"

# Isolated HOME and workspace; nothing touches the operator's ~/.nexus or ~/.config/nexus.
cell_home="$(mktemp -d "${TMPDIR:-/tmp}/nexus-terminal-$cell.XXXXXX")"
ws="$cell_home/workspace"
mkdir -p "$ws" "$cell_home/.config/nexus"
git -C "$ws" init -q
printf 'terminal matrix workspace\n' > "$ws/README.md"
mock_log="$cell_home/mock.log"
python3 "$HERE/mockgw.py" "$cell_home/port" "$mock_log" &
mock_pid=$!
canary_pid=""
cleanup() { kill "$mock_pid" ${canary_pid:+"$canary_pid"} 2>/dev/null || true; rm -rf "$cell_home"; }
trap cleanup EXIT
for _ in $(seq 50); do [[ -s "$cell_home/port" ]] && break; sleep 0.1; done
port="$(cat "$cell_home/port")"
printf 'LOCAL_LLM_ENDPOINT=http://127.0.0.1:%s/v1\nLOCAL_LLM_MODEL=terminal-matrix\n' "$port" > "$cell_home/.config/nexus/config.env"

# The TUI sees only a whitelisted environment, so operator gateway or API settings cannot redirect it.
launch_env=(env -i PATH="$PATH" HOME="$cell_home" XDG_CONFIG_HOME="$cell_home/.config" XDG_DATA_HOME="$cell_home/.local/share"
  XDG_STATE_HOME="$cell_home/.local/state" XDG_CACHE_HOME="$cell_home/.cache" LANG="${LANG:-C.UTF-8}")
for var in TERM COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION VTE_VERSION KITTY_WINDOW_ID TMUX TMUX_PANE XTERM_VERSION DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do
  [[ -n "${!var:-}" ]] && launch_env+=("$var=${!var}")
done

# Processes from this cell: HOME is the cell's HOME, or the working directory is inside the cell workspace.
cell_processes() {
  local pid
  for pid in $(pgrep -u "$(id -u)"); do
    [[ "$pid" == "$mock_pid" || "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
    if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "HOME=$cell_home" || [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$ws"* ]]; then
      echo "$pid"
    fi
  done
}
# Positive control: the scan must find a planted process before it is trusted to report zero.
(cd "$ws" && exec env HOME="$cell_home" sleep 600) &
canary_pid=$!
sleep 0.3
cell_processes | grep -qx "$canary_pid" || { echo "survivor scan cannot see a planted cell process; refusing to measure" >&2; exit 1; }
kill "$canary_pid"; wait "$canary_pid" 2>/dev/null || true; canary_pid=""

# Each launch runs in its own transient systemd user scope. The cgroup probe
# reports zero only for a readable empty cgroup or a scope systemd confirms is
# stopped/gone; missing data while active remains an explicit failed measure.
launch() {
  local label="$1"; shift
  local before after status=0 survivors scoped scope_measurement=verified unit="nexus-terminal-$cell-$attempt-$label"
  before="$(stty -g)"
  (cd "$ws" && systemd-run --user --scope --quiet --unit="$unit" -- "${launch_env[@]}" "$@" nexus) || status=$?
  after="$(stty -g)"
  sleep 2
  if ! scoped="$(nexus_terminal_scope_procs "$unit")"; then
    scoped=0
    scope_measurement=unavailable
  fi
  survivors="$(cell_processes | wc -l)"
  (( scoped > survivors )) && survivors="$scoped"
  [[ "$survivors" == 0 && "$scope_measurement" == verified ]] || { cell_processes | xargs -r ps -o pid=,args= -p >&2; systemctl --user kill --signal=KILL "$unit.scope" 2>/dev/null || true; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$status" "$([[ "$before" == "$after" ]] && echo true || echo false)" "$survivors" "$scope_measurement" "$(date -u +%FT%TZ)" >> "$cell_home/exits.tsv"
  # Measurements reach the evidence directory as they happen, so an attempt abandoned later still shows them.
  cp "$cell_home/exits.tsv" "$stem.partial"
}

cat <<EOF

=== Cell $cell, attempt $attempt ($rc, package $package) ===
In the TUI that opens next (the first word of each prompt selects the mock scenario):
  1  It launches and shows the TUI.
  2  Prompt "approve". While each of the two approval panels is open, type continuously, paste 3 lines, then
     approve with a deliberate key.
  3  Enter a multiline prompt with Shift+Enter (or Alt+Enter).
  4  Prompt "stream" and resize the window while it streams; restore $size afterwards.
  5  Prompt "sleep" and press Esc while "sleep 30" runs.
  6  Quit with Ctrl-C twice. Confirm the terminal is restored (echo on, no stray escape codes).
Press Enter to launch.
EOF
read -r _
launch main
cat <<EOF

7  NO_COLOR: the TUI opens again with NO_COLOR=1. Check that it is readable without colour, then quit with Ctrl-C twice.
Press Enter to launch.
EOF
read -r _
launch no_color NO_COLOR=1

# Answers are saved before anything else can fail, so a typo in a screenshot path does not lose them.
: > "$cell_home/checks.tsv"
for check in 1 2 3 4 5 6 7; do
  while true; do
    read -r -p "check $check PASS or FAIL? " answer
    answer="${answer^^}"; [[ "$answer" == PASS || "$answer" == FAIL ]] && break
  done
  read -r -p "check $check note (optional): " note
  printf '%s\t%s\t%s\n' "$check" "$answer" "${note//$'\t'/ }" >> "$cell_home/checks.tsv"
done
cp "$cell_home/checks.tsv" "$stem.answers.tsv"
cp "$cell_home/exits.tsv" "$stem.exits.tsv"
cp "$mock_log" "$stem.mock.log"
read -r -p "operator name: " operator
shot_approval="" shot_exit="" approval_copy="" exit_copy=""
if [[ "$rc" =~ ^v1\.0\.0-rc\.[0-9]+$ ]]; then
  read -r -p "Attach optional approval and post-exit screenshots? (y/N): " screenshot_choice
  screenshots_requested="${screenshot_choice,,}"
else
  echo "Screenshots are required for $rc; DEC-18 applies only to v1.0.0-rc.N."
  screenshots_requested="yes"
fi
if [[ "$screenshots_requested" == y || "$screenshots_requested" == yes ]]; then
  while true; do
    read -r -p "approval-panel screenshot path: " shot_approval
    read -r -p "post-exit screenshot path: " shot_exit
    if [[ "$shot_approval" =~ \.(png|jpe?g)$ && "$shot_exit" =~ \.(png|jpe?g)$ && -f "$shot_approval" && -f "$shot_exit" ]] \
       && ! cmp -s "$shot_approval" "$shot_exit" \
       && (( $(stat -c %Y "$shot_approval") >= attempt_start && $(stat -c %Y "$shot_exit") >= attempt_start )); then break; fi
    echo "both optional screenshots must be distinct .png/.jpg files taken during this attempt; try again"
  done
  approval_copy="$stem.approval.${shot_approval##*.}"
  exit_copy="$stem.post-exit.${shot_exit##*.}"
  cp "$shot_approval" "$approval_copy"
  cp "$shot_exit" "$exit_copy"
fi

# Values reach Python only through the environment, never through generated source.
CELL="$cell" ATTEMPT="$attempt" TERMINAL_NAME="$terminal" CELL_SIZE="$size" RC="$rc" NEXUS_VERSION_LINE="$version_line" \
NEXUS_PATH="$nexus_real" PACKAGE_DIR="$package" MANIFEST_SHA="$manifest_sha" TMUX_VERSION="$tmux_version" \
KITTY_PROTOCOL="$kitty_protocol" OPERATOR_NAME="$operator" STEM="$stem" APPROVAL_SHOT="$approval_copy" EXIT_SHOT="$exit_copy" \
python3 - <<'PY'
import hashlib, json, os
e = os.environ
stem = e["STEM"]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
exits = []
for line in open(f"{stem}.exits.tsv"):
    label, status, restored, survivors, scope_measurement, at = line.rstrip("\n").split("\t")
    exits.append({"launch": label, "exitStatus": int(status), "sttyRestored": restored == "true", "survivors": int(survivors), "scopeMeasurement": scope_measurement, "at": at})
checks = {}
for line in open(f"{stem}.answers.tsv"):
    check, result, note = (line.rstrip("\n").split("\t") + [""])[:3]
    checks[check] = {"result": result, "note": note}
# Scenario proof from the mock log: which prompts and tool rounds actually reached the gateway.
scenarios = {"approveToolRounds": set(), "stream": 0, "sleepTool": 0}
for line in open(f"{stem}.mock.log"):
    entry = json.loads(line)
    prompt, tools = entry["turn"]
    if prompt == "approve" and entry["kind"] == "tools": scenarios["approveToolRounds"].add(tools)
    if prompt == "stream" and entry["kind"] == "stream": scenarios["stream"] += 1
    if prompt == "sleep" and entry["kind"] == "tools": scenarios["sleepTool"] += 1
scenarios["approveToolRounds"] = sorted(scenarios["approveToolRounds"])
files = {name: {"path": os.path.basename(path), "sha256": sha(path)} for name, path in
         [("mockLog", f"{stem}.mock.log"), ("answers", f"{stem}.answers.tsv"), ("exits", f"{stem}.exits.tsv")]}
for name, env_name in [("approvalScreenshot", "APPROVAL_SHOT"), ("postExitScreenshot", "EXIT_SHOT")]:
    if e[env_name]:
        files[name] = {"path": os.path.basename(e[env_name]), "sha256": sha(e[env_name])}
record = {
    "acceptance": "ACCEPTANCE §5.3", "cell": e["CELL"], "attempt": int(e["ATTEMPT"]), "terminal": e["TERMINAL_NAME"], "size": e["CELL_SIZE"],
    "rc": e["RC"], "nexusVersion": e["NEXUS_VERSION_LINE"], "nexusPath": e["NEXUS_PATH"], "packageDir": e["PACKAGE_DIR"],
    "packageManifestSha256": e["MANIFEST_SHA"],
    "env": {k: e.get(k) for k in ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "VTE_VERSION", "KITTY_WINDOW_ID", "TMUX", "XTERM_VERSION"]},
    "tmux": e["TMUX_VERSION"] or None, "kittyKeyboardProtocol": e["KITTY_PROTOCOL"] or None,
    "measured": exits, "scenarios": scenarios, "checks": checks,
    "files": files,
    "operator": e["OPERATOR_NAME"],
}
with open(f"{stem}.json", "x") as f:
    json.dump(record, f, indent=2)
PY
sha256sum "$stem.json" > "$stem.json.sha256"
rm -f "$stem.partial"
echo "recorded $stem.json"
