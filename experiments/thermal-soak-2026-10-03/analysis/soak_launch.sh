#!/bin/bash
# wait for a cool start (all GPU sensors <= 34 C, max 15 min), then run the soak
hottest() { python3 - <<'PY'
import glob
m=0
for h in glob.glob("/sys/class/hwmon/hwmon*"):
    if open(h+"/name").read().strip()!="xe": continue
    for t in glob.glob(h+"/temp*_input"): m=max(m,int(open(t).read())/1000)
print(m)
PY
}
start=$(date +%s)
while :; do
  h=$(hottest); waited=$(( $(date +%s) - start ))
  if awk "BEGIN{exit !($h <= 34)}"; then echo "cool start reached: hottest=${h}C after ${waited}s"; break; fi
  if [ $waited -ge 900 ]; then echo "cool-start wait capped at 900s: hottest=${h}C (recorded; baseline phase will show the true starting state)"; break; fi
  sleep 10
done
SOAK_SCALE=1 python3 /tmp/soak.py
