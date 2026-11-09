#!/bin/bash
# usage: source t.sh ; helpers
S=${S:-/tmp/nexus-tui-audit}
# The checkout whose cli/dist is driven: the repository this file lives in, unless WT is set.
WT=${WT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}
start() { # name cols rows [extra args] [env...]
  local n=$1 c=${2:-120} r=${3:-40}; shift 3
  tmux kill-session -t $n 2>/dev/null
  tmux new-session -d -s $n -x $c -y $r "env HOME=$S/home NEXUS_STATE_DIR=$S/state XDG_CONFIG_HOME=$S/home/.config TERM=${TERMV:-xterm-256color} COLORTERM=${COLORTERMV-truecolor} $EXTRAENV node $WT/cli/dist/index.js --live -w $S/ws -e ${ENDPOINT:-http://127.0.0.1:18080/v1} -m fake-model $* ; echo EXIT_CODE=\$? ; sleep 600"
}
cap() { tmux capture-pane -p -t $1 ${2:-}; }
k() { local n=$1; shift; tmux send-keys -t $n "$@"; }
lit() { local n=$1; shift; tmux send-keys -t $n -l "$*"; }
