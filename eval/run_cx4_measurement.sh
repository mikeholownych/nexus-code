#!/usr/bin/env bash
# CX-4: the same large-output tasks with masking off and on, one run at a time, under the GATEWAY claim.
# Usage: eval/run_cx4_measurement.sh <out-dir> [runs-per-arm]   (take the GATEWAY claim first; the key comes from the environment)
set -eu
OUT="${1:?out dir}"; RUNS="${2:-5}"
cd "$(dirname "$0")/.."
for arm in cx4-unmasked cx4-masked-2000; do
  node eval/run.mjs --config "eval/configs/$arm.json" --out "$OUT/$arm" --only cx4-verbose-fix,cx4-log-triage,cx4-wide-rename --runs "$RUNS"
done
