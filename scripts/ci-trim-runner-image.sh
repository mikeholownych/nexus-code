#!/usr/bin/env bash
set -euo pipefail

# Hosted ubuntu images preinstall SDKs (Android, .NET, Swift, JVMs, cloud CLIs)
# under the system roots that the evaluator sandbox mounts. The fail-closed
# compiler inventory must traverse those roots within its fixed deadline, and
# millions of unrelated SDK entries exceed it. Qualification hosts do not carry
# these trees, so remove them from the ephemeral runner instead of relaxing the
# inventory. This only deletes files on a disposable GitHub-hosted runner.
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "refusing to trim a host that is not a GitHub-hosted runner" >&2
  exit 2
fi

readonly SDK_TREES=(
  /usr/local/lib/android
  /usr/share/dotnet
  /usr/share/swift
  /usr/share/miniconda
  /usr/share/kotlinc
  /usr/share/sbt
  /usr/share/az_*
  /usr/lib/jvm
  /usr/lib/google-cloud-sdk
  /usr/lib/firefox
  /usr/lib/heroku
  /usr/lib/mono
)

for tree in "${SDK_TREES[@]}"; do
  [[ -e "$tree" ]] || continue
  echo "removing $tree"
  sudo rm -rf --one-file-system "$tree"
done

# Record what the inventory will still traverse, so a future image change that
# grows these roots is visible in the job log rather than only as a timeout.
for root in /usr/bin /usr/lib /usr/lib64 /usr/libexec /usr/share /lib /lib64 /usr/local/lib /etc/alternatives; do
  [[ -d "$root" && ! -L "$root" ]] || continue
  start=$(date +%s%N)
  count=$(find -P "$root" 2>/dev/null | wc -l)
  echo "inventory root $root entries=$count elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))"
done
