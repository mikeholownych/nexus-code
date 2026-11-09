#!/bin/bash
# fresh isolated env under the scratch workspace $S (default /tmp/nexus-tui-audit).
# $S must be a scratch directory: new, empty, or one this script set up before (it leaves a marker file). Anything
# else is refused, so a wrong or unset path can never have its README.md/package.json overwritten and committed.
set -euo pipefail
S=${S:-/tmp/nexus-tui-audit}
MARKER="$S/.nexus-tui-audit-scratch"
if [ -e "$S" ] && [ ! -e "$MARKER" ] && [ -n "$(ls -A "$S")" ]; then
  echo "setup.sh: refusing to use $S: it is not empty and was not set up by this script (no $MARKER)" >&2
  exit 1
fi
mkdir -p "$S" && touch "$MARKER"
rm -rf "${S:?}/home" "${S:?}/ws" "${S:?}/state"; mkdir -p "$S/home" "$S/ws" "$S/state"
cd "$S/ws" || exit 1
git init -q && git config user.name t && git config user.email t@t.invalid
echo base > base.txt; printf '# Demo\n\nA small repository.\n' > README.md; echo '{"name":"demo","scripts":{"test":"echo ok"}}' > package.json
git add . && git commit -qm base
if [ "${1:-}" = trust ]; then
  mkdir -p "$S/home/.config/nexus"
  printf '{"trustedPaths":["%s"]}\n' "$(realpath "$S/ws")" > "$S/home/.config/nexus/trusted_workspaces.json"
fi
