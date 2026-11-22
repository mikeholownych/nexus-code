#!/usr/bin/env bash
# Formatting gate scoped to changed Rust files. The core has pre-existing rustfmt drift, so a whole-tree
# `cargo fmt --check` would fail every PR for reasons unrelated to the change under review.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base="${NEXUS_FMT_BASE:-origin/main}"
if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  base=HEAD~1
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
