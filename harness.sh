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

TUI_BIN="$SCRIPT_DIR/core/target/release/nexus-tui"

run_tui() {
  exec "$TUI_BIN" --live --sidecar "$SCRIPT_DIR/cli/dist/sidecar.js" --node "$NODE_EXEC" -- "$@"
}

# No arguments: the live TUI when it is built and both ends are a terminal; otherwise the readline REPL.
if [[ $# -eq 0 ]]; then
  if [[ -x "$TUI_BIN" && -t 0 && -t 1 ]]; then
    run_tui
  fi
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus: the live TUI is not built (run 'make build' in $SCRIPT_DIR); starting the REPL." >&2
  fi
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" repl
elif [[ "$1" == "--repl" ]]; then
  shift
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" repl "$@"
elif [[ "$1" == "--live" ]]; then
  shift
  if [[ ! -x "$TUI_BIN" ]]; then
    echo "nexus-tui is not built. Run 'make build' in $SCRIPT_DIR first." >&2
    exit 1
  fi
  run_tui "$@"
elif [[ "$1" == "check" ]] || [[ "$1" == "models" ]] || [[ "$1" == "sessions" ]] || [[ "$1" == "skills" ]] || [[ "$1" == "mcp" ]] || [[ "$1" == "plugins" ]] || [[ "$1" == "checkpoints" ]] || [[ "$1" == "audit" ]] || [[ "$1" == "serve-mcp" ]] || [[ "$1" == "run" ]] || [[ "$1" == "repl" ]] || [[ "$1" == "providers" ]] || [[ "$1" == "connect" ]] || [[ "$1" == "disconnect" ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--version" ]] || [[ "$1" == "-V" ]]; then
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" "$@"
else
  exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" run "$@"
fi
