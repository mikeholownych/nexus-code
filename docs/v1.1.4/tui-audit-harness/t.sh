#!/bin/bash
# usage: source t.sh ; helpers
S=${S:-/tmp/nexus-tui-audit}
# The checkout whose cli/dist is driven: the repository this file lives in, unless WT is set.
WT=${WT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}
start() { # name [cols] [rows] [extra CLI args]; env for the CLI via EXTRAENV, TERMV, COLORTERMV, ENDPOINT
  local n=$1 c=${2:-120} r=${3:-40} extra="" cmd
  shift $(( $# < 3 ? $# : 3 ))
  if (( $# )); then printf -v extra '%q ' "$@"; fi
  # Every path is quoted for the shell tmux starts, so a scratch path with a space works.
  printf -v cmd 'env HOME=%q NEXUS_STATE_DIR=%q XDG_CONFIG_HOME=%q TERM=%q COLORTERM=%q %s node %q --live -w %q -e %q -m fake-model %s; echo EXIT_CODE=$? ; sleep 600' \
    "$S/home" "$S/state" "$S/home/.config" "${TERMV:-xterm-256color}" "${COLORTERMV-truecolor}" "${EXTRAENV:-}" "$WT/cli/dist/index.js" "$S/ws" "${ENDPOINT:-http://127.0.0.1:18080/v1}" "$extra"
  tmux kill-session -t "$n" 2>/dev/null
  tmux new-session -d -s "$n" -x "$c" -y "$r" "$cmd"
}
cap() { tmux capture-pane -p -t "$1" ${2:+"$2"}; }
k() { local n=$1; shift; tmux send-keys -t "$n" "$@"; }
lit() { local n=$1; shift; tmux send-keys -t "$n" -l "$*"; }
