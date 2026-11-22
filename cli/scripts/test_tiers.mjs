// T0 inner-loop tier: pure-logic tests that need no network, no real provider and no special host fixtures.
// This is a smoke tier, not a completeness claim: `npm test` remains the PR-required suite.
// `node scripts/test_tiers.mjs --list` prints the file list for CI artefact/metrics reporting.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(cli, "scripts", "run_tests.mjs");

export const UNIT_FILES = [
  "test/protocol.test.ts",
  "test/protocol_golden.test.ts",
  "test/diff_coverage.test.ts",
  "test/security.test.ts",
  "test/tool_grammar.test.ts",
  "test/approval_policy.test.ts",
  "test/client_tool_grammar.test.ts",
  "test/flight_sanitization.test.ts",
  "test/flight_exclude.test.ts",
  "test/test_shards.test.ts",
  "test/capabilities.test.ts",
];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--list")) {
    process.stdout.write(`${UNIT_FILES.join("\n")}\n`);
  } else {
    const child = spawn(process.execPath, [runner, ...UNIT_FILES], {
      cwd: cli,
      stdio: "inherit",
      env: { ...process.env, NEXUS_TEST_TIER: "unit" },
    });
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  }
}
