#!/usr/bin/env bash
# Run a command with the evaluator fixtures that .github/workflows/ci.yml provisions:
#   NEXUS_EVAL_TEST_WORKSPACE_ROOT  a dedicated 128m tmpfs (mode 0711, owned by the caller)
#   NEXUS_EVAL_TEST_RUNTIME_ROOT    a public runtime directory (mode 0711, owned by the caller)
# Same paths, size and modes as CI. The tmpfs and directories are removed when the command ends,
# but only if this script created them; anything that already exists is refused, never reused or deleted.
# Usage: scripts/with-ci-fixtures.sh [--check] -- <command> [args...]
set -euo pipefail

readonly WORKSPACE_ROOT=/mnt/nexus-eval-ci
readonly RUNTIME_ROOT=/opt/nexus-eval-ci-runtime

check_only=0
if [[ "${1:-}" == "--check" ]]; then check_only=1; shift; fi
if [[ "${1:-}" == "--" ]]; then shift; fi
if [[ $check_only -eq 0 && $# -eq 0 ]]; then
  echo "usage: $0 [--check] -- <command> [args...]" >&2
  exit 64
fi

if [[ "$(uname -s)" != "Linux" ]]; then echo "with-ci-fixtures: Linux only (tmpfs mount)" >&2; exit 2; fi
if [[ "$(id -u)" -eq 0 ]]; then echo "with-ci-fixtures: run as the unprivileged user that runs the tests" >&2; exit 2; fi
if mountpoint -q "$WORKSPACE_ROOT" 2>/dev/null; then
  echo "with-ci-fixtures: $WORKSPACE_ROOT is already a mount point; refusing to reuse or unmount it" >&2; exit 2
fi
for dir in "$WORKSPACE_ROOT" "$RUNTIME_ROOT"; do
  if [[ -e "$dir" ]]; then
    echo "with-ci-fixtures: $dir already exists; remove it (when empty) and retry" >&2; exit 2
  fi
done
if [[ $check_only -eq 1 ]]; then
  echo "with-ci-fixtures: would mount a 128m tmpfs at $WORKSPACE_ROOT and create $RUNTIME_ROOT (needs sudo)"
  exit 0
fi

mounted=0; created_workspace=0; created_runtime=0
cleanup() {
  local status=$?
  if [[ $mounted -eq 1 ]]; then sudo umount "$WORKSPACE_ROOT" || echo "with-ci-fixtures: could not unmount $WORKSPACE_ROOT" >&2; fi
  if [[ $created_workspace -eq 1 ]]; then sudo rmdir "$WORKSPACE_ROOT" || true; fi
  if [[ $created_runtime -eq 1 ]]; then sudo rm -rf --one-file-system -- "$RUNTIME_ROOT"; fi
  exit "$status"
}
trap cleanup EXIT

sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0711 "$WORKSPACE_ROOT"; created_workspace=1
sudo mount -t tmpfs -o "size=128m,mode=0711,uid=$(id -u),gid=$(id -g)" nexus-eval-ci "$WORKSPACE_ROOT"; mounted=1
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0711 "$RUNTIME_ROOT"; created_runtime=1

NEXUS_EVAL_TEST_WORKSPACE_ROOT="$WORKSPACE_ROOT" NEXUS_EVAL_TEST_RUNTIME_ROOT="$RUNTIME_ROOT" "$@"
