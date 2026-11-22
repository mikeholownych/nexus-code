#!/usr/bin/env bash
# Formatting gate scoped to changed Rust files. The core has pre-existing rustfmt drift, so a whole-tree
# `cargo fmt --check` would fail every PR for reasons unrelated to the change under review.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# CI passes the pull-request base SHA. Locally, prefer the active release branch and
# never fall back to HEAD~1: a shallow or otherwise incomplete checkout must fail
# closed rather than silently check no files.
base="${NEXUS_FMT_BASE:-}"
if [ -z "$base" ]; then
  for candidate in origin/release/v1.3.0 origin/main; do
    if git rev-parse --verify --quiet "${candidate}^{commit}" >/dev/null; then
      base="$candidate"
      break
    fi
  done
fi
if [ -z "$base" ] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "[fmt] cannot resolve a formatting base; set NEXUS_FMT_BASE to a fetched commit" >&2
  exit 1
fi

files="$(
  {
    git diff --name-only --diff-filter=ACMRTUXB "${base}...HEAD" 2>/dev/null || true
    git diff --name-only --diff-filter=ACMRTUXB
    git diff --cached --name-only --diff-filter=ACMRTUXB
  } | sort -u | grep -E '^core/.*\.rs$' || true
)"

if [ -z "$files" ]; then
  echo "[fmt] no changed Rust files; nothing to check"
  exit 0
fi

rc=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  if ! rustfmt --edition 2024 --check "$file"; then
    echo "[fmt] FAILED: $file" >&2
    rc=1
  fi
done <<<"$files"
exit "$rc"
