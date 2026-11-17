#!/usr/bin/env bash
# A task that finishes only when a trusted verifier passes. The verifier command is the operator's, not the model's:
# `--authoritative-verifier` must succeed before Nexus will report the task complete, and the exit code says so.
# `--deliverable-file add.js` declares the product file the task is meant to change: the verifier's own definition is
# snapshotted before the task starts, and an edit to anything else it reads would (rightly) void the verification.
#   0  the task completed and the verifier passed
#   !0 anything else (verifier failing, task blocked, budget reached, cancelled)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/project/." "$work/"
git -C "$work" init -q
git -C "$work" -c user.name=example -c user.email=example@example.invalid add -A
git -C "$work" -c user.name=example -c user.email=example@example.invalid commit -q -m "start"

status=0
# shellcheck disable=SC2086
${NEXUS:-nexus} run -y -w "$work" --authoritative-verifier "node --test" --deliverable-file add.js ${NEXUS_ARGS:-} \
  "Fix add() in add.js so that the test in test/add.test.js passes." || status=$?
echo "nexus exit status: $status"
exit "$status"
