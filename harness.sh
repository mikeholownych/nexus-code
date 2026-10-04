#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks so the script works when symlinked into /usr/local/bin or ~/bin
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
NODE_EXEC="${NODE_EXEC:-node}"

# If no arguments provided, drop into the interactive REPL
if [[ $# -eq 0 ]]; then
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" repl
elif [[ "$1" == "--live" ]]; then
  shift
  TUI_BIN="$SCRIPT_DIR/core/target/release/nexus-tui"
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus-tui is not built. Run 'make build' in $SCRIPT_DIR first." >&2
    exit 1
  fi
  exec "$TUI_BIN" --live --sidecar "$SCRIPT_DIR/cli/dist/sidecar.js" --node "$NODE_EXEC" -- "$@"
elif [[ "$1" == "check" ]] || [[ "$1" == "models" ]] || [[ "$1" == "sessions" ]] || [[ "$1" == "skills" ]] || [[ "$1" == "mcp" ]] || [[ "$1" == "plugins" ]] || [[ "$1" == "checkpoints" ]] || [[ "$1" == "audit" ]] || [[ "$1" == "serve-mcp" ]] || [[ "$1" == "run" ]] || [[ "$1" == "repl" ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--version" ]] || [[ "$1" == "-V" ]]; then
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" "$@"
else
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" run "$@"
fi
