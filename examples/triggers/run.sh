#!/usr/bin/env bash
# Fire an approved trigger once and show its receipt. Usage: run.sh [file|webhook]   (default: file)
#
# Approving is yours to do, in a terminal, after reading what it prints:
#   nexus trust "$(git rev-parse --show-toplevel)"
#   mkdir -p .nexus && cp examples/triggers/triggers.json .nexus/triggers.json && chmod 600 .nexus/triggers.json
#   nexus triggers approve
# This script starts a runner if none is running, triggers the event, waits for the job and prints its receipt.
set -euo pipefail

mode="${1:-file}"
nexus_bin="${NEXUS_BIN:-nexus}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git rev-parse --show-toplevel)"
cd "$repo"
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

case "$mode" in
  file) id=example-readme; runner_args=() ;;
  webhook) id=example-hook; runner_args=(--webhook-port 0)
    : "${NEXUS_TRIGGER_EXAMPLE_HOOK:?set NEXUS_TRIGGER_EXAMPLE_HOOK to a secret of at least 16 characters, in the environment the runner is started from}" ;;
  *) echo "usage: run.sh [file|webhook]" >&2; exit 2 ;;
esac

if ! "$nexus_bin" triggers status "$id" | grep -q "may run: yes"; then
  "$nexus_bin" triggers status "$id" || true
  echo "$id is not approved here: read .nexus/triggers.json, then run \`nexus triggers approve\` in a terminal (see the top of this script)." >&2
  exit 3
fi

if ! "$nexus_bin" runner status >/dev/null 2>&1; then
  "$nexus_bin" runner serve --max-jobs 1 "${runner_args[@]}" >"$runner_log" 2>&1 &
  runner_pid=$!
  for _ in {1..300}; do
    if "$nexus_bin" runner status >/dev/null 2>&1; then break; fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then cat "$runner_log" >&2; exit 1; fi
    sleep 0.1
  done
fi

# The runner records what it has armed; wait until this trigger is ready.
for _ in {1..300}; do
  if "$nexus_bin" triggers status "$id" | grep -q "armed: yes"; then break; fi
  sleep 0.2
done
"$nexus_bin" triggers status "$id" | grep -q "armed: yes" || { "$nexus_bin" triggers status "$id" >&2; echo "the runner did not arm $id" >&2; exit 1; }

if [[ "$mode" == file ]]; then
  printf 'Triggered by the example at %s.\n' "$(date -u +%FT%TZ)" >>README.md
else
  url="$("$nexus_bin" triggers status "$id" | sed -n 's/^ *webhook: POST \(\/hook\/[^ ]*\) on \(.*\)$/http:\/\/\2\1/p')"
  [[ -n "$url" ]] || { echo "the runner has no webhook listener open" >&2; exit 1; }
  node "$here/deliver.mjs" "$url" '{"event":"example"}'
fi

for _ in {1..600}; do
  if "$nexus_bin" triggers status "$id" | grep -q "^  fired: [1-9]"; then break; fi
  sleep 0.2
done
job="$("$nexus_bin" triggers status "$id" | sed -n 's/^  fired: .* job \(job-[0-9a-f]*\) .*/\1/p')"
[[ -n "$job" ]] || { echo "the trigger did not fire" >&2; "$nexus_bin" triggers status "$id" >&2; exit 1; }
echo "started $job"
"$nexus_bin" job logs --follow "$job" >/dev/null
"$nexus_bin" job status "$job"
"$nexus_bin" triggers status "$id"
