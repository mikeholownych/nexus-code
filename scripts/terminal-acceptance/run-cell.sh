#!/usr/bin/env bash
# One cell of the manual real-terminal matrix (ACCEPTANCE §5.3), run by a human INSIDE the terminal under test, sized
# to the cell. It checks the installed RC identity and the size, launches the TUI against a deterministic local mock
# from an isolated HOME, and captures the evidence that can be measured:
#   - terminal state (stty) before and after each exit;
#   - processes started from the cell's HOME that survive an exit (check 5);
#   - the mock's request log.
# The human records PASS/FAIL per check and the screenshot paths. Usage:
#   scripts/terminal-acceptance/run-cell.sh --rc v1.0.0-rc.N --terminal <xterm|kitty|tmux-gnome|vscode|gnome> \
#     --size <80x24|40x14|200x60> --out <evidence dir>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
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
[[ "$rc" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "--rc must be vX.Y.Z[-rc.N]" >&2; exit 2; }
[[ "$terminal" =~ ^(xterm|kitty|tmux-gnome|vscode|gnome)$ ]] || { echo "--terminal must be xterm|kitty|tmux-gnome|vscode|gnome" >&2; exit 2; }
[[ "$size" =~ ^(80x24|40x14|200x60)$ ]] || { echo "--size must be 80x24|40x14|200x60" >&2; exit 2; }
[[ -n "$out" ]] || { echo "--out is required" >&2; exit 2; }
[[ -t 0 && -t 1 ]] || { echo "run this interactively in the terminal under test" >&2; exit 2; }

cell="$terminal-$size"
record="$out/cell-$cell.json"
[[ ! -e "$record" ]] || { echo "$record exists; a cell is recorded once (keep failed attempts under a new --out)" >&2; exit 2; }
mkdir -p "$out"

# Identity: the installed RC on PATH, never a checkout build.
nexus_bin="$(command -v nexus)" || { echo "nexus is not on PATH; install the RC with the documented one-line command" >&2; exit 2; }
nexus_real="$(readlink -f "$nexus_bin")"
version_line="$(nexus --version 2>&1 | head -n 1)"
[[ "$version_line" == *"${rc#v}"* ]] || { echo "installed nexus reports '$version_line', not $rc" >&2; exit 2; }
case "$nexus_real" in "$HOME"/nexus-code/*|*/nexus-wt/*) echo "nexus resolves to a checkout ($nexus_real); install the RC" >&2; exit 2 ;; esac

# Size: the terminal must already be the cell's size.
want_cols="${size%x*}" want_rows="${size#*x}"
read -r rows cols < <(stty size)
[[ "$cols" == "$want_cols" && "$rows" == "$want_rows" ]] || { echo "terminal is ${cols}x${rows}; resize it to $size first" >&2; exit 2; }
if [[ "$terminal" == tmux-gnome ]]; then
  [[ -n "${TMUX:-}" ]] || { echo "run inside tmux (inside GNOME Terminal)" >&2; exit 2; }
  tmux_version="$(tmux -V)"; [[ "$tmux_version" =~ ^tmux\ 3\. ]] || { echo "need tmux 3.x, have $tmux_version" >&2; exit 2; }
fi

# Isolated HOME and workspace; nothing touches the operator's ~/.nexus or ~/.config/nexus.
cell_home="$(mktemp -d "${TMPDIR:-/tmp}/nexus-terminal-$cell.XXXXXX")"
ws="$cell_home/workspace"
mkdir -p "$ws" "$cell_home/.config/nexus"
git -C "$ws" init -q
printf 'terminal matrix workspace\n' > "$ws/README.md"
mock_log="$cell_home/mock.log"
python3 "$HERE/mockgw.py" "$cell_home/port" "$mock_log" &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do [[ -s "$cell_home/port" ]] && break; sleep 0.1; done
port="$(cat "$cell_home/port")"
printf 'LOCAL_LLM_ENDPOINT=http://127.0.0.1:%s/v1\nLOCAL_LLM_MODEL=terminal-matrix\n' "$port" > "$cell_home/.config/nexus/config.env"
cell_env=(HOME="$cell_home" XDG_CONFIG_HOME="$cell_home/.config" XDG_DATA_HOME="$cell_home/.local/share" XDG_STATE_HOME="$cell_home/.local/state")

# Processes still running from this cell's HOME (excluding the mock), read from /proc environments.
survivors() {
  local n=0 pid
  for pid in $(pgrep -u "$(id -u)"); do
    [[ "$pid" == "$mock_pid" || "$pid" == "$$" ]] && continue
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "HOME=$cell_home" && { n=$((n + 1)); ps -o pid=,args= -p "$pid" >&2; }
  done
  echo "$n"
}

launch() {
  local label="$1"; shift
  local before after
  before="$(stty -g)"
  (cd "$ws" && env "${cell_env[@]}" "$@" nexus) || true
  after="$(stty -g)"
  sleep 1
  printf '%s\t%s\t%s\t%s\n' "$label" "$before" "$after" "$(survivors)" >> "$cell_home/exits.tsv"
}

cat <<EOF

=== Cell $cell ($rc at $nexus_real) ===
In the TUI that opens next:
  1  It launches and shows the TUI.
  2  Prompt "approve". While each approval panel is open, type continuously, paste 3 lines, then approve with a
     deliberate key. Screenshot the approval panel.
  3  Enter a multiline prompt with Shift+Enter (or Alt+Enter).
  4  Prompt "stream" and resize the window while it streams; restore the size $size afterwards.
  5  Prompt "sleep" and press Esc while "sleep 30" runs.
  6  Quit with Ctrl-C twice. Screenshot the terminal after exit.
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

: > "$cell_home/checks.tsv"
for check in 1 2 3 4 5 6 7; do
  while true; do
    read -r -p "check $check PASS or FAIL? " answer
    answer="${answer^^}"; [[ "$answer" == PASS || "$answer" == FAIL ]] && break
  done
  read -r -p "check $check note (optional): " note
  printf '%s\t%s\t%s\n' "$check" "$answer" "${note//$'\t'/ }" >> "$cell_home/checks.tsv"
done
read -r -p "approval-panel screenshot path: " shot_approval
read -r -p "post-exit screenshot path: " shot_exit
read -r -p "operator name: " operator
for shot in "$shot_approval" "$shot_exit"; do [[ -f "$shot" ]] || { echo "screenshot $shot not found; record not written" >&2; exit 1; }; done
approval_copy="$out/cell-$cell-approval.${shot_approval##*.}"
exit_copy="$out/cell-$cell-post-exit.${shot_exit##*.}"
cp "$shot_approval" "$approval_copy"
cp "$shot_exit" "$exit_copy"
cp "$mock_log" "$out/cell-$cell-mock.log"

# Values reach Python only through the environment, never through generated source.
CELL="$cell" TERMINAL_NAME="$terminal" CELL_SIZE="$size" RC="$rc" NEXUS_VERSION_LINE="$version_line" NEXUS_PATH="$nexus_real" \
TMUX_VERSION="${tmux_version:-}" OPERATOR_NAME="$operator" EXITS="$cell_home/exits.tsv" CHECKS="$cell_home/checks.tsv" \
APPROVAL_SHOT="$approval_copy" EXIT_SHOT="$exit_copy" MOCK_LOG="$out/cell-$cell-mock.log" \
python3 - "$record" <<'PY'
import hashlib, json, os, sys
e = os.environ
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
exits = []
for line in open(e["EXITS"]):
    label, before, after, survivors = line.rstrip("\n").split("\t")
    exits.append({"launch": label, "sttyRestored": before == after, "survivors": int(survivors)})
checks = {}
for line in open(e["CHECKS"]):
    check, result, note = (line.rstrip("\n").split("\t") + [""])[:3]
    checks[check] = {"result": result, "note": note}
record = {
    "acceptance": "ACCEPTANCE §5.3", "cell": e["CELL"], "terminal": e["TERMINAL_NAME"], "size": e["CELL_SIZE"],
    "rc": e["RC"], "nexusVersion": e["NEXUS_VERSION_LINE"], "nexusPath": e["NEXUS_PATH"], "nexusSha256": sha(e["NEXUS_PATH"]),
    "env": {k: e.get(k) for k in ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "VTE_VERSION", "KITTY_WINDOW_ID", "TMUX"]},
    "tmux": e["TMUX_VERSION"] or None,
    "measured": exits,
    "checks": checks,
    "screenshots": {"approval": sha(e["APPROVAL_SHOT"]), "postExit": sha(e["EXIT_SHOT"])},
    "mockLogSha256": sha(e["MOCK_LOG"]),
    "operator": e["OPERATOR_NAME"],
}
json.dump(record, open(sys.argv[1], "w"), indent=2)
PY
echo "recorded $record"
rm -rf "$cell_home"
