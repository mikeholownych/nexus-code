#!/usr/bin/env bash
# Add a read-only schedule for the current Git checkout, run it once by hand and show what the schedule reports.
# Configure the normal Nexus endpoint first. This trusts the checkout (nexus trust) so a schedule may be added for it:
# read the repository before you run this on one you did not write.
set -euo pipefail

nexus_bin="${NEXUS_BIN:-nexus}"
name="${NEXUS_SCHEDULE_NAME:-example-readme}"
repo="$(git rev-parse --show-toplevel)"
runner_pid=""
runner_log="$(mktemp)"
cleanup() {
  "$nexus_bin" schedule remove "$name" >/dev/null 2>&1 || true
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  rm -f "$runner_log"
}
trap cleanup EXIT

if ! "$nexus_bin" runner status >/dev/null 2>&1; then
  "$nexus_bin" runner serve --max-jobs 1 >"$runner_log" 2>&1 &
  runner_pid=$!
  ready=0
  for _ in {1..100}; do
    if "$nexus_bin" runner status >/dev/null 2>&1; then ready=1; break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then cat "$runner_log" >&2; exit 1; fi
    sleep 0.1
  done
  if [[ "$ready" != 1 ]]; then cat "$runner_log" >&2; echo "runner did not become ready" >&2; exit 1; fi
fi

args=()
if [[ -n "${NEXUS_RUNNER_ENDPOINT:-}" ]]; then args+=(--endpoint "$NEXUS_RUNNER_ENDPOINT"); fi
if [[ -n "${NEXUS_RUNNER_MODEL:-}" ]]; then args+=(--model "$NEXUS_RUNNER_MODEL"); fi

"$nexus_bin" trust "$repo"
# Every day, read-only (no --allow-worktree-write): each run reads in its own fresh worktree and changes nothing.
"$nexus_bin" schedule add --name "$name" --every 1d --workspace "$repo" \
  --prompt "Read README.md and report its first line. Do not modify files." "${args[@]}"
job="$("$nexus_bin" schedule run-now "$name")"
echo "started $job"
"$nexus_bin" job logs --follow "$job" >/dev/null
# Outcome, receipt, newest result and every run the schedule missed.
"$nexus_bin" schedule status "$name"
"$nexus_bin" schedule list
