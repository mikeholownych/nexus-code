// Runs the CLI test suite with a throwaway HOME so no test (or anything it spawns: the sidecar, the TUI, PTY drivers)
// can read or write the operator's ~/.nexus or ~/.config/nexus. The real home is passed as NEXUS_TEST_REAL_HOME so the
// guard test can prove the isolation held. Arguments are test files; none means every test/*.test.ts.
// NEXUS_KEEP_TEST_HOME=1 keeps the temporary home for inspection.
// One node:test run (run_tests_driver.mjs, in its own process group, files one at a time as before) with a per-file
// watchdog: a file still running after NEXUS_TEST_FILE_TIMEOUT_SECS (default 300) is named with its last output, the
// whole group is killed, and the run restarts with the remaining files so every other failure is still reported.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-home-"));

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : [
      ...fs.readdirSync(path.join(cli, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join("test", f)),
      path.resolve(cli, "../eval/dataset.test.mjs"),
      path.resolve(cli, "../eval/package_runtime.test.mjs"),
    ];

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  NEXUS_TEST_REAL_HOME: realHome,
};
// This process writes the durations file. A test that starts a nested runner must not inherit the path and write over it.
delete env.NEXUS_TEST_DURATIONS_OUT;
// Rust and Node toolchains installed per user keep working under the throwaway home.
for (const [key, dir] of [["CARGO_HOME", ".cargo"], ["RUSTUP_HOME", ".rustup"]]) {
  if (!env[key] && fs.existsSync(path.join(realHome, dir))) env[key] = path.join(realHome, dir);
}

const timeoutSecs = Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) > 0 ? Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) : 300;
const driver = path.join(cli, "scripts", "run_tests_driver.mjs");
let current = null;

function killGroup(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

function cleanupHome() {
  if (process.env.NEXUS_KEEP_TEST_HOME === "1") console.error(`test home kept at ${home}`);
  else fs.rmSync(home, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (current) killGroup(current);
    cleanupHome();
    process.exit(1);
  });
}

function runSegment(segment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [driver, ...segment], { cwd: cli, env, detached: true, stdio: ["inherit", "inherit", "inherit", "pipe"] });
    current = child;
    const result = { timedOut: undefined, done: undefined };
    let buffered = "";
    child.stdio[3].on("data", (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.done) result.done = message;
        if (message.duration) {
          const { file, secs } = message.duration;
          durations.set(file, Math.max(durations.get(file) ?? 0, secs));
        }
        if (message.timeout && !result.timedOut) {
          result.timedOut = message.timeout;
          console.error(`\nTEST FILE TIMEOUT after ${timeoutSecs}s: ${message.timeout}\nlast output:\n${message.tail.map((l) => `  | ${l}`).join("\n")}`);
          killGroup(child);
        }
      }
    });
    child.on("error", () => resolve(result));
    child.on("close", () => { killGroup(child); resolve(result); });
  });
}

let remaining = files;
let tests = 0;
let failures = 0;
const timedOut = [];
const durations = new Map();
let crashed = false;
while (remaining.length) {
  const result = await runSegment(remaining);
  if (result.done) {
    tests += result.done.tests;
    failures += result.done.fail;
    break;
  }
  if (!result.timedOut) { crashed = true; break; }
  timedOut.push(result.timedOut);
  const at = remaining.findIndex((f) => path.resolve(cli, f) === result.timedOut);
  remaining = at < 0 ? [] : remaining.slice(at + 1);
}

if (process.env.NEXUS_TEST_DURATIONS_OUT) {
  const out = path.resolve(process.env.NEXUS_TEST_DURATIONS_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const measured = Object.fromEntries([...durations.entries()].sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(out, `${JSON.stringify(measured, null, 2)}\n`);
  console.error(`[test-durations] wrote ${Object.keys(measured).length} measured files to ${out}`);
}
cleanupHome();
const bad = failures > 0 || timedOut.length > 0 || crashed;
if (timedOut.length || crashed) console.error(`\ntimed out: ${timedOut.join(", ") || "none"}${crashed ? "; the test driver exited without a result" : ""}; tests (completed segments): ${tests}, fail: ${failures}`);
process.exit(bad ? 1 : 0);
