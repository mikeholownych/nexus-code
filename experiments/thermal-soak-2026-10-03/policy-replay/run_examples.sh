#!/bin/sh
# Reproduces every example report. Read-only on the raw evidence; outputs go to ./output/<policy>/ (report.txt + result.json).
# ILLUSTRATIVE ONLY: the example policies are demonstrations of the tool, not recommendations.
set -eu
cd "$(dirname "$0")"
for p in reference-current-75-85-90 example-persistence-demo example-hysteresis-demo example-class-split-demo; do
  python3 thermal_policy_replay.py --policy examples/$p.json --quiet
done
python3 thermal_policy_replay.py --policy examples/example-boundary-demo.json --compare-persistence 1,5,10,30,60 --quiet
python3 thermal_policy_replay.py --policy examples/example-missing-samples-demo.json --drop gpu1:vram_hottest_channel:1200:1230 --quiet
