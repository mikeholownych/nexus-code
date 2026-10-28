#!/usr/bin/env bash
set -euo pipefail
ARCHIVE=${1:?usage: smoke-package.sh ARCHIVE}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
NEXUS="$TMP/nexus/bin/nexus"
VERSION=$(cat "$TMP/nexus/VERSION")
"$NEXUS" --version | grep -F "${VERSION#v}" >/dev/null
"$NEXUS" --help >/dev/null
set +e
mkdir -p "$TMP/doctor-home"
HOME="$TMP/doctor-home" "$NEXUS" doctor --json > "$TMP/doctor.json"
DOCTOR_STATUS=$?
set -e
[ "$DOCTOR_STATUS" -le 2 ] || { cat "$TMP/doctor.json" >&2; echo "packaged doctor failed to run" >&2; exit 1; }
node -e 'const d=require(process.argv[1]); if (d.schemaVersion !== 2) process.exit(1)' "$TMP/doctor.json"
# One version everywhere (REQ-REL-103): a fresh install's engine check passes, never a version warning.
node -e 'const d=require(process.argv[1]); const e=d.findings.find((f)=>f.id==="engine.binary"); if (!e || e.status!=="pass") { console.error(JSON.stringify(e)); process.exit(1) }' "$TMP/doctor.json"

# ACC-PKG-06: nexus doctor 2>err; test ! -s err on a healthy fixture install
set +e
HOME="$TMP/doctor-home" "$NEXUS" doctor 2>"$TMP/doctor.err" >/dev/null
DOCTOR_RUN_STATUS=$?
set -e
[ "$DOCTOR_RUN_STATUS" -le 2 ] || { cat "$TMP/doctor.err" >&2; echo "doctor failed to run" >&2; exit 1; }
[ ! -s "$TMP/doctor.err" ] || { cat "$TMP/doctor.err" >&2; echo "doctor emitted stderr on healthy install" >&2; exit 1; }

# ACC-PKG-07: packaged doctor remedies contain no make or harness.sh
if grep -E "make|harness\.sh" "$TMP/doctor.json" >/dev/null; then
  echo "packaged doctor JSON contains make or harness.sh remedy" >&2
  exit 1
fi

# ACC-PKG-01: PTY launch of the installed nexus asserts the TUI header and idle hint
python3 "$(dirname "$0")/package-smoke-pty.py" "$NEXUS" > "$TMP/pty.out"
grep -F "NEXUS" "$TMP/pty.out" >/dev/null || { cat "$TMP/pty.out" >&2; echo "PTY launch missing TUI header" >&2; exit 1; }
grep -E "(ask Nexus|commands|enter send)" "$TMP/pty.out" >/dev/null || { cat "$TMP/pty.out" >&2; echo "PTY launch missing idle hint" >&2; exit 1; }

# ACC-PKG-01: nexus repl gives the REPL prompt
printf '/exit\n' | "$NEXUS" repl > "$TMP/repl.out" 2>&1
grep -E "(nexus|❯)" "$TMP/repl.out" >/dev/null || { cat "$TMP/repl.out" >&2; echo "nexus repl did not render REPL prompt" >&2; exit 1; }

# ACC-PKG-01: </dev/null nexus gives the REPL
"$NEXUS" </dev/null > "$TMP/null.out" 2>&1
grep -E "(nexus|❯)" "$TMP/null.out" >/dev/null || { cat "$TMP/null.out" >&2; echo "</dev/null nexus did not render REPL prompt" >&2; exit 1; }

# ACC-PKG-02: doc-command extraction test passes against the package
node "$(dirname "$0")/doc_commands.mjs" "$NEXUS"

# ACC-SUP-01: archive contains THIRD_PARTY_NOTICES.txt covering full dependency closure
test -s "$TMP/nexus/THIRD_PARTY_NOTICES.txt"
node "$(dirname "$0")/check_notices.mjs" "$TMP/nexus/THIRD_PARTY_NOTICES.txt"

test -x "$TMP/nexus/lib/core/harness-core"
test -x "$TMP/nexus/lib/core/nexus-tui"
node --input-type=module - "$TMP/nexus/lib/cli/dist/tools.js" "$TMP/nexus/lib/core/harness-core" "$TMP/nexus/compatibility.json" "$TMP/nexus/lib/cli/dist/core/state.js" <<'EOF'
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const moduleUrl = pathToFileURL(process.argv[2]).href;
process.env.NEXUS_HOME = process.argv[3].replace(/\/lib\/core\/harness-core$/, '');
const { resolveCoreBinary } = await import(moduleUrl);
if (resolveCoreBinary() !== process.argv[3]) throw new Error('packaged core resolution failed');
const { CURRENT_STATE_SCHEMA_VERSION } = await import(pathToFileURL(process.argv[5]).href);
const metadata = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
if (metadata.compatibility.stateSchemaVersion !== CURRENT_STATE_SCHEMA_VERSION) throw new Error('packaged state schema disagrees with compatibility metadata');
EOF
"$TMP/nexus/lib/core/harness-core" --help >/dev/null
cat > "$TMP/snapshot.json" <<'EOF'
{"model":"smoke","workspace":"/tmp","task_id":"smoke","objective":"package smoke","activity":[],"plan":[],"validation":null,"context":"0 messages","status":"IDLE","theme":"default"}
EOF
"$TMP/nexus/lib/core/nexus-tui" --plain "$TMP/snapshot.json" | grep -F NEXUS >/dev/null

# Create the log before starting the background process. Bash may schedule the
# next command before the child's redirection creates this file.
: > "$TMP/server.out"
node "$(dirname "$0")/package-smoke-server.mjs" > "$TMP/server.out" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do
  PORT=$(sed -n 's/^PORT=//p' "$TMP/server.out" | head -n 1)
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "${PORT:-}" ] || { cat "$TMP/server.out" >&2; echo "inference fixture did not start" >&2; exit 1; }
mkdir -p "$TMP/home" "$TMP/work"
set +e
HOME="$TMP/home" LOCAL_LLM_ENDPOINT="http://127.0.0.1:$PORT/v1" LOCAL_LLM_MODEL=package-smoke LOCAL_LLM_API_KEY=fixture \
  "$NEXUS" run "Reply exactly with NEXUS_PACKAGE_SMOKE_OK and make no changes." --json --max-steps 1 --max-total-steps 1 --no-continuation --workspace "$TMP/work" > "$TMP/run.json"
RUN_STATUS=$?
set -e
grep -F NEXUS_PACKAGE_SMOKE_OK "$TMP/run.json" >/dev/null || { cat "$TMP/run.json" >&2; echo "installed client did not complete inference smoke" >&2; exit 1; }
[ "$RUN_STATUS" -eq 0 ] || [ "$RUN_STATUS" -eq 2 ] || { echo "unexpected inference smoke exit status: $RUN_STATUS" >&2; exit 1; }
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
printf 'PACKAGE_SMOKE_PASS %s\n' "$ARCHIVE"
