// Runs the CLI test suite with a throwaway HOME so no test (or anything it spawns: the sidecar, the TUI, PTY drivers)
// can read or write the operator's ~/.nexus or ~/.config/nexus. The real home is passed as NEXUS_TEST_REAL_HOME so the
// guard test can prove the isolation held. Arguments are test files; none means every test/*.test.ts.
// NEXUS_KEEP_TEST_HOME=1 keeps the temporary home for inspection.
// Each file runs in its own process group and is killed with its whole group after NEXUS_TEST_FILE_TIMEOUT_SECS (default
// 300), naming the file and its last output; files run one at a time (the old --test-concurrency=1).
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
// Rust and Node toolchains installed per user keep working under the throwaway home.
for (const [key, dir] of [["CARGO_HOME", ".cargo"], ["RUSTUP_HOME", ".rustup"]]) {
  if (!env[key] && fs.existsSync(path.join(realHome, dir))) env[key] = path.join(realHome, dir);
}

const tsx = path.join(cli, "node_modules", ".bin", "tsx");
const timeoutSecs = Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) > 0 ? Number(process.env.NEXUS_TEST_FILE_TIMEOUT_SECS) : 300;
let current = null;

function killGroup(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(tsx, ["--test", "--test-concurrency=1", file], { cwd: cli, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    current = child;
    let tail = [];
    let partial = "";
    const onData = (stream) => (chunk) => {
      stream.write(chunk);
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      tail = [...tail, ...lines].slice(-20);
    };
    child.stdout.on("data", onData(process.stdout));
    child.stderr.on("data", onData(process.stderr));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\nTEST FILE TIMEOUT after ${timeoutSecs}s: ${file}\nlast output:\n${[...tail, partial].filter(Boolean).map((l) => `  | ${l}`).join("\n")}`);
      killGroup(child);
    }, timeoutSecs * 1000);
    child.on("error", () => { clearTimeout(timer); resolve({ file, ok: false, timedOut }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child);
      resolve({ file, ok: code === 0 && !timedOut, timedOut });
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (current) killGroup(current);
    process.exit(1);
  });
}

const results = [];
for (const file of files) results.push(await runFile(file));

if (process.env.NEXUS_KEEP_TEST_HOME === "1") console.error(`test home kept at ${home}`);
else fs.rmSync(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.error(`\nfiles: ${results.length}, failed: ${failed.length}${failed.length ? ` (${failed.map((r) => r.file + (r.timedOut ? " [timeout]" : "")).join(", ")})` : ""}`);
process.exit(failed.length ? 1 : 0);
