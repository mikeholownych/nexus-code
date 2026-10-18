#!/bin/sh
if [ -n "${NEXUS_HIDDEN_FILES_LIST:-}" ] && [ -f "$NEXUS_HIDDEN_FILES_LIST" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && rm -f -- "$f"
  done < "$NEXUS_HIDDEN_FILES_LIST"
fi
exec "$@"
