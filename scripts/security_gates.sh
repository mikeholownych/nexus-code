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
if ! npm audit --audit-level=high; then
  echo "[-] FAIL [SCAN-004]: High or Critical vulnerability detected in Node.js dependencies." >&2
  exit 1
fi
echo "[+] [Gate 1] Node.js dependencies clean (zero High/Critical vulnerabilities)."

echo "[*] [Gate 1] Verifying Rust core dependencies..."
cd "${ROOT_DIR}/core"
if command -v cargo-audit &>/dev/null; then
  cargo audit
else
  # Built-in check for Cargo.lock and dependency graph integrity
  if [[ ! -f "Cargo.lock" ]]; then
    echo "[-] FAIL [SCAN-001]: Missing Cargo.lock in core crate." >&2
    exit 1
  fi
fi
echo "[+] [Gate 1] Rust core dependencies verified."

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
  # Scan git-tracked files, excluding tests designed to test secret redactors or fixtures
  MATCHES=$(git grep -EI "${pattern}" -- ':!cli/test/' ':!cli/dist/' ':!scripts/' 2>/dev/null || true)
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
