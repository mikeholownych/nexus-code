// Runs the CLI test suite with a throwaway HOME so no test (or anything it spawns: the sidecar, the TUI, PTY drivers)
// can read or write the operator's ~/.nexus or ~/.config/nexus. The real home is passed as NEXUS_TEST_REAL_HOME so the
// guard test can prove the isolation held. Arguments are test files; none means every test/*.test.ts.
// NEXUS_KEEP_TEST_HOME=1 keeps the temporary home for inspection.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-home-"));

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(cli, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join("test", f));

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
const result = spawnSync(tsx, ["--test", "--test-concurrency=1", ...files], { cwd: cli, env, stdio: "inherit" });

if (process.env.NEXUS_KEEP_TEST_HOME === "1") console.error(`test home kept at ${home}`);
else fs.rmSync(home, { recursive: true, force: true });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
