#!/bin/sh
# A pre-tool hook: refuses a `git push` that forces. Nexus gives the call as one JSON object on standard input (see
# docs/HOOKS.md). Exit status 2 denies the call, and standard error is the reason the model and the receipt show.
# Exit status 0 with no output is "no objection"; it does not approve anything.
#
# The whole payload is searched instead of one JSON field, so quoting inside the command cannot hide the push. That
# can refuse more than it must; hooks.json limits this hook to run_command, which keeps that to shell commands.
payload=$(cat)
if printf '%s' "$payload" | grep -Eq 'git[[:space:]].*push.*[[:space:]](--force(-with-lease)?|-f)([^[:alnum:]-]|$)'; then
  echo "force pushes are not allowed from an agent session: push without --force, or ask the operator" >&2
  exit 2
fi
exit 0
