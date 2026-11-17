#!/usr/bin/env bash
# Run a task in its own git worktree, then merge it back only if it verified. Your checkout is untouched while the
# task runs; the worktree and its branch are kept so you can read the diff before merging.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/../verified-completion/project/." "$work/"
git -C "$work" init -q -b main
git -C "$work" -c user.name=example -c user.email=example@example.invalid add -A
git -C "$work" -c user.name=example -c user.email=example@example.invalid commit -q -m "start"

# shellcheck disable=SC2086
${NEXUS:-nexus} run -y -w "$work" --worktree-branch fix-add --authoritative-verifier "node --test" --deliverable-file add.js ${NEXUS_ARGS:-} \
  "Fix add() in add.js so that the test in test/add.test.js passes."
echo "branch fix-add holds the result; main is unchanged:"
git -C "$work" log --oneline main | head -n 3
