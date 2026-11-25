#!/usr/bin/env bash
# Shows the effective sandbox profile of `--sandbox :workspace`, `:read-only` and `:network` with `nexus doctor`.
# No model is called and no command is run: the doctor only reports the confinement the session would have. The
# endpoint below is never contacted for inference (the doctor's own reachability probe fails, which is ignored here).
# A throwaway HOME keeps your own ~/.config/nexus out of it. Residual holes: docs/SANDBOX_PROFILES.md.
set -euo pipefail
HOME="$(mktemp -d)"
export HOME
trap 'rm -rf "$HOME"' EXIT
work="$HOME/work"
mkdir -p "$work"

# The doctor exits non-zero when anything it checks is not healthy (here: the unreachable endpoint); only its report matters.
doctor() {
  { ${NEXUS:-nexus} "$@" doctor --json -w "$work" -e http://127.0.0.1:9/v1 -m example --timeout 3000 2>/dev/null || true; } |
    node -e '
      let text = "";
      process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        const report = JSON.parse(text);
        const posture = report.posture;
        if (posture) {
          console.log(`profile: ${posture.profile} (${posture.profileSource})`);
          console.log(`sandbox: ${posture.sandbox}`);
        }
        const invalid = report.findings.find((f) => f.id === "config.valid" && f.status === "fail");
        if (invalid) {
          console.log(`refused: ${invalid.evidence[0]}`);
          return;
        }
        const finding = report.findings.find((f) => f.id === "sandbox.confinement");
        if (finding) console.log(`sandbox.confinement: ${finding.explanation}`);
      });'
}

for profile in :workspace :read-only :network; do
  echo "--- nexus --sandbox $profile doctor"
  doctor --sandbox "$profile"
done

echo "--- no profile named: the label is derived from the settings in force"
doctor

echo "--- a profile that has no network refuses --sandbox-network"
doctor --sandbox :workspace --sandbox-network
