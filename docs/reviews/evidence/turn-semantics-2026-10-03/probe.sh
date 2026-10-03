#!/usr/bin/env bash
# probe.sh <scenario> <port> <extra env...> -- <nexus args>
S=/tmp/claude-1000/-home-mike-nexus-code/f49bb728-a69a-48c0-89ef-013caf5b0791/scratchpad
sc=$1; port=$2; shift 2
rm -f $S/gw-$sc.log
node $S/fakegw.mjs $port $sc $S/gw-$sc.log >/dev/null 2>&1 &
GW=$!
sleep 0.7
cd $S/ws && git checkout -q . && git clean -fdq
HOME=$S/home LOCAL_LLM_ENDPOINT=http://127.0.0.1:$port/v1 "$@"
echo "EXIT=$?"
kill $GW 2>/dev/null
