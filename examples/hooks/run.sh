#!/usr/bin/env bash
# Installs the example hook into a throwaway HOME and tries it against two sample tool calls with `nexus hooks test`.
# No model is called and no tool is run: the hook alone decides. Your own ~/.config/nexus is not touched.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME="$(mktemp -d)"
export HOME
trap 'rm -rf "$HOME"' EXIT
mkdir -p "$HOME/.config/nexus/hooks"
chmod 700 "$HOME/.config/nexus"
cp "$here/deny-force-push.sh" "$HOME/.config/nexus/hooks/"
install -m 600 "$here/hooks.json" "$HOME/.config/nexus/hooks.json"
work="$HOME/work"
mkdir -p "$work"

${NEXUS:-nexus} hooks list -w "$work"

echo "--- an ordinary push: the hook has no objection"
${NEXUS:-nexus} hooks test pre-tool -w "$work" --tool run_command --input '{"command":"git push origin main"}'

echo "--- a forced push: the hook denies it"
status=0
${NEXUS:-nexus} hooks test pre-tool -w "$work" --tool run_command --input '{"command":"git push --force origin main"}' || status=$?
if [ "$status" -ne 2 ]; then
  echo "expected the forced push to be denied (exit status 2), got $status" >&2
  exit 1
fi
echo "denied, as it should be (exit status 2)"
