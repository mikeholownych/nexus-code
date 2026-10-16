#!/usr/bin/env bash
# Nexus Code Security Lifecycle Gates (WP-11, INC-12, SCAN-001..SCAN-005, REL-001..REL-004)
# Enforces non-bypassable pre-commit, build, and release security gates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "========================================================"
echo "  NEXUS CODE LIFECYCLE SECURITY SCANNING GATES (INC-12) "
echo "========================================================"

# SCAN-002 / SCAN-004: Non-bypassable check. Any attempt to bypass fails the gate.
if [[ -n "${SKIP_SECURITY_GATES:-}" && "${SKIP_SECURITY_GATES}" != "0" && "${SKIP_SECURITY_GATES}" != "false" ]]; then
  echo "[-] ERROR [SCAN-002]: Security gates are non-bypassable. SKIP_SECURITY_GATES is prohibited." >&2
  exit 1
fi

if [[ -n "${BYPASS_SECURITY_SCAN:-}" && "${BYPASS_SECURITY_SCAN}" != "0" && "${BYPASS_SECURITY_SCAN}" != "false" ]]; then
  echo "[-] ERROR [SCAN-002]: Security gates are non-bypassable. BYPASS_SECURITY_SCAN is prohibited." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Gate 1: Dependency Vulnerability Audit (SCAN-001, SCAN-004)
# -----------------------------------------------------------------------------
echo "[*] [Gate 1] Auditing Node.js dependencies via npm audit..."
cd "${ROOT_DIR}/cli"
# npm exports its configuration to child processes as npm_config_* variables. When this gate runs under
# `npm test`, a user-level `allow-scripts` setting from ~/.npmrc arrives here as npm_config_allow_scripts, which
# npm 11 treats as a command-line option and refuses for project-scoped commands (EALLOWSCRIPTS). Dropping the
# inherited copy changes nothing else: npm still reads the same ~/.npmrc and project configuration itself.
AUDIT_ERR="$(mktemp)"
trap 'rm -f "${AUDIT_ERR}"' EXIT
set +e
AUDIT_JSON="$(env -u npm_config_allow_scripts npm audit --json --audit-level=high 2>"${AUDIT_ERR}")"
AUDIT_STATUS=$?
set -e
# A scanner that could not run is not a vulnerability finding, and neither is a pass: both fail the gate, with
# different reasons.
AUDIT_VERDICT="$(printf '%s' "${AUDIT_JSON}" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  let report;
  try { report = JSON.parse(raw); } catch { console.log("unreadable"); return; }
  if (report.error) { console.log(`error ${report.error.code || "unknown"}: ${report.error.summary || ""}`.trim()); return; }
  const counts = report.metadata && report.metadata.vulnerabilities;
  if (!counts || typeof counts.high !== "number" || typeof counts.critical !== "number") { console.log("unreadable"); return; }
  console.log(counts.high + counts.critical > 0 ? `findings high=${counts.high} critical=${counts.critical}` : "clean");
});' 2>/dev/null || echo "unreadable")"
case "${AUDIT_VERDICT}" in
  clean)
    if [[ ${AUDIT_STATUS} -ne 0 ]]; then
      echo "[-] FAIL [SCAN-005]: npm audit exited ${AUDIT_STATUS} without reporting High/Critical findings; the scan result cannot be trusted." >&2
      exit 1
    fi
    ;;
  findings*)
    echo "${AUDIT_VERDICT}" >&2
    echo "[-] FAIL [SCAN-004]: High or Critical vulnerability detected in Node.js dependencies (${AUDIT_VERDICT#findings })." >&2
    exit 1
    ;;
  *)
    sed -n '1,5p' "${AUDIT_ERR}" >&2
    echo "[-] FAIL [SCAN-005]: Node.js vulnerability scanner could not run (${AUDIT_VERDICT}; exit ${AUDIT_STATUS}). This is a scanner execution or configuration failure, not a vulnerability finding; dependency safety is not established." >&2
    exit 1
    ;;
esac
echo "[+] [Gate 1] Node.js dependencies clean (zero High/Critical vulnerabilities)."

echo "[*] [Gate 1] Verifying Rust core dependencies..."
cd "${ROOT_DIR}/core"
if [[ ! -f "Cargo.lock" ]]; then
  echo "[-] FAIL [SCAN-001]: Missing Cargo.lock in core crate." >&2
  exit 1
fi

if [[ -n "${SIMULATE_RUST_SCANNER_UNAVAILABLE:-}" && "${SIMULATE_RUST_SCANNER_UNAVAILABLE}" == "1" ]]; then
  echo "[-] FAIL [SCAN-001]: Rust vulnerability scanner unavailable. Security gates cannot establish dependency safety." >&2
  exit 1
fi

if command -v cargo-deny &>/dev/null; then
  if ! cargo deny --config "${ROOT_DIR}/deny.toml" check licenses advisories; then
    echo "[-] FAIL [SCAN-002]: cargo deny reported policy failure (licenses or advisories) in Rust core dependencies." >&2
    exit 1
  fi
elif command -v cargo-audit &>/dev/null; then
  if ! cargo audit; then
    echo "[-] FAIL [SCAN-002]: cargo audit reported vulnerability in Rust core dependencies." >&2
    exit 1
  fi
else
  echo "[-] FAIL [SCAN-001]: Rust vulnerability scanner unavailable (neither cargo-audit nor cargo-deny found in PATH). Security gates cannot establish dependency safety." >&2
  exit 1
fi
echo "[+] [Gate 1] Rust core dependencies verified (zero High/Critical vulnerabilities)."

# -----------------------------------------------------------------------------
# Gate 2: Secret Scanning across Workspace & Candidate Trees (SCAN-003, TEST-003)
# -----------------------------------------------------------------------------
echo "[*] [Gate 2] Scanning workspace and tracked files for unredacted credentials..."
cd "${ROOT_DIR}"

# Patterns for common sensitive tokens (private keys, API tokens, passwords)
SECRET_PATTERNS=(
  "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
  "ghp_[A-Za-z0-9_]{36,}"
  "sk-[A-Za-z0-9]{20,}"
  "bearer [A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}"
  "xox[baprs]-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}"
)

DETECTED_SECRETS=0
for pattern in "${SECRET_PATTERNS[@]}"; do
  # Scan git-tracked files, excluding tests designed to test secret redactors or fixtures (including the synthetic
  # credentials in review reproduction tests; the review documents themselves are scanned)
  MATCHES=$(git grep -EI "${pattern}" -- ':!cli/test/' ':!cli/dist/' ':!scripts/' ':(glob,exclude)docs/reviews/evidence/*/repro/**' 2>/dev/null || true)
  if [[ -n "${MATCHES}" ]]; then
    echo "[-] FAIL [SCAN-003]: Potential plaintext secret detected matching pattern: ${pattern}" >&2
    echo "${MATCHES}" >&2
    DETECTED_SECRETS=$((DETECTED_SECRETS + 1))
  fi
done

if [[ ${DETECTED_SECRETS} -gt 0 ]]; then
  echo "[-] FAIL [SCAN-003]: Credential scanner detected ${DETECTED_SECRETS} unredacted secret(s)." >&2
  exit 1
fi
echo "[+] [Gate 2] Zero unredacted credentials detected in codebase."

# -----------------------------------------------------------------------------
# Gate 3: Git Hygiene and Whitespace Validation
# -----------------------------------------------------------------------------
echo "[*] [Gate 3] Validating git diff hygiene..."
if ! git diff --check; then
  echo "[-] FAIL [SCAN-001]: Git diff check failed (whitespace or conflict markers)." >&2
  exit 1
fi
echo "[+] [Gate 3] Git diff hygiene clean."

echo "========================================================"
echo "  ALL SECURITY LIFECYCLE GATES PASSED CLEANLY (INC-12)  "
echo "========================================================"
exit 0
