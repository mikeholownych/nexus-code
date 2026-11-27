#!/usr/bin/env bash
# Start one read-only background job in the current Git checkout. Configure the normal Nexus endpoint first.
set -euo pipefail

nexus_bin="${NEXUS_BIN:-nexus}"
runner_pid=""
runner_log="$(mktemp)"
cleanup() {
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
"$nexus_bin" job start --prompt "Read README.md and report its first line. Do not modify files." --verifier "test -s README.md" --wait "${args[@]}"
