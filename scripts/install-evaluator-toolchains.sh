#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
policy_file="$repo_root/eval/toolchain-versions.json"
rust_toolchain_file="$repo_root/rust-toolchain.toml"

go_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["go"])' "$policy_file")"
rust_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rust"])' "$policy_file")"
toolchain_rust_version="$(sed -n 's/^channel = "\([0-9][0-9.]*\)"$/\1/p' "$rust_toolchain_file")"

if [[ ! "$go_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$rust_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "evaluator toolchain policy must contain exact semantic versions" >&2
  exit 1
fi
if [[ "$rust_version" != "$toolchain_rust_version" ]]; then
  echo "evaluator Rust version does not match rust-toolchain.toml" >&2
  exit 1
fi

assert_internal_symlinks() {
  python3 - "$1" <<'PY'
import os
import sys

root = os.path.realpath(sys.argv[1], strict=True)
for current, directories, files in os.walk(root, followlinks=False):
    for name in (*directories, *files):
        item = os.path.join(current, name)
        if not os.path.islink(item):
            continue
        try:
            target = os.path.realpath(item, strict=True)
            inside = os.path.commonpath((root, target)) == root
        except (OSError, ValueError):
            inside = False
        if not inside:
            print(f"toolchain symlink is broken or escapes its root: {item}", file=sys.stderr)
            sys.exit(1)
PY
}

expected_go="go${go_version}"
actual_go="$(go version | awk '{print $3}')"
if [[ "$actual_go" != "$expected_go" ]]; then
  echo "Go version mismatch: expected $expected_go, got $actual_go" >&2
  exit 1
fi

rustup toolchain install "$rust_version" --profile minimal --component clippy --component rustfmt
rust_root="$(rustup run "$rust_version" rustc --print sysroot)"
actual_rustc="$(rustup run "$rust_version" rustc --version | awk '{print $2}')"
actual_cargo="$(rustup run "$rust_version" cargo --version | awk '{print $2}')"
if [[ "$actual_rustc" != "$rust_version" || "$actual_cargo" != "$rust_version" ]]; then
  echo "Rust toolchain version mismatch: expected $rust_version, got rustc=$actual_rustc cargo=$actual_cargo" >&2
  exit 1
fi

go_root="$(go env GOROOT)"
test -n "$go_root" && test -d "$go_root"
test -n "$rust_root" && test -d "$rust_root"
go_root="$(realpath -e -- "$go_root")"
rust_root="$(realpath -e -- "$rust_root")"
assert_internal_symlinks "$go_root"
assert_internal_symlinks "$rust_root"
sudo rm -rf -- /usr/local/go /usr/local/nexus-qual/rust
sudo install -d -o root -g root -m 0755 /usr/local /usr/local/go /usr/local/nexus-qual /usr/local/nexus-qual/rust
# Materialize the trees so a symlinked hosted-toolcache root or any linked
# entry cannot survive into the evaluator's pinned, non-replaceable roots.
sudo cp -aL -- "$go_root/." /usr/local/go/
sudo cp -aL -- "$rust_root/." /usr/local/nexus-qual/rust/
sudo chown -hR root:root /usr/local/go /usr/local/nexus-qual/rust
sudo chmod -R go-w /usr/local/go /usr/local/nexus-qual/rust

copied_go="$(/usr/local/go/bin/go version | awk '{print $3}')"
copied_rustc="$(/usr/local/nexus-qual/rust/bin/rustc --version | awk '{print $2}')"
copied_cargo="$(/usr/local/nexus-qual/rust/bin/cargo --version | awk '{print $2}')"
if [[ "$copied_go" != "$expected_go" || "$copied_rustc" != "$rust_version" || "$copied_cargo" != "$rust_version" ]]; then
  echo "copied evaluator toolchain version mismatch: go=$copied_go rustc=$copied_rustc cargo=$copied_cargo" >&2
  exit 1
fi
