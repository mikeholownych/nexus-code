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

unset NEXUS_HOME
export NEXUS_ROOT="$SCRIPT_DIR"
exec "$NODE_EXEC" "$SCRIPT_DIR/cli/dist/index.js" "$@"
