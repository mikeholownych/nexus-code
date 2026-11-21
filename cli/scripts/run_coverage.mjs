// Runs the full CLI suite with Node's built-in V8 coverage and writes an lcov report.
// The throwaway HOME matches run_tests.mjs; this runner deliberately has no per-file watchdog,
// so callers (CI) must apply an outer timeout. The spec reporter still goes to stdout.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCliTestFiles } from "./test_shards.mjs";
import { UNIT_FILES } from "./test_tiers.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-coverage-home-"));
const outFlag = process.argv.indexOf("--out");
const out = path.resolve(process.argv[outFlag + 1] || process.env.NEXUS_COVERAGE_OUT || path.join(cli, "coverage", "lcov.info"));
fs.mkdirSync(path.dirname(out), { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  NEXUS_TEST_REAL_HOME: realHome,
};
for (const [key, dir] of [["CARGO_HOME", ".cargo"], ["RUSTUP_HOME", ".rustup"]]) {
  if (!env[key] && fs.existsSync(path.join(realHome, dir))) env[key] = path.join(realHome, dir);
}

const args = [
  "--import", "tsx",
  "--test",
  "--experimental-test-coverage",
  "--test-reporter=spec", "--test-reporter-destination=/dev/stdout",
  "--test-reporter=lcov", `--test-reporter-destination=${out}`,
  ...(process.argv.includes("--tier=unit") ? UNIT_FILES : listCliTestFiles()),
];

const child = spawn(process.execPath, args, { cwd: cli, env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  fs.rmSync(home, { recursive: true, force: true });
  console.error(`[coverage] lcov written to ${out}`);
  process.exit(code ?? (signal ? 1 : 0));
});
