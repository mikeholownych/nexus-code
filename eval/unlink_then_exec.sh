#!/bin/sh
unset NODE_OPTIONS
node -e 'for (const f of JSON.parse(process.env.NEXUS_HIDDEN_FILES || "[]")) require("node:fs").rmSync(f, { force: true })'
unset NEXUS_HIDDEN_FILES NEXUS_HIDDEN_FILES_LIST NODE_OPTIONS PYTHONPATH CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER
exec "$@"
