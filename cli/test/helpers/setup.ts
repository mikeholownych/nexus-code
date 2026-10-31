import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Global test setup for HOME and state directory isolation (REQ-PER-103, ACC-PER-03, PLAN-08 Task 1).
const realHome = process.env.NEXUS_TEST_REAL_HOME || os.homedir();
if (!process.env.NEXUS_TEST_REAL_HOME) {
  process.env.NEXUS_TEST_REAL_HOME = realHome;
}

if (!process.env.HOME || path.resolve(process.env.HOME) === path.resolve(realHome)) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-test-home-"));
  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
  process.env.XDG_DATA_HOME = path.join(isolatedHome, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(isolatedHome, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(isolatedHome, ".cache");
  process.env.NEXUS_STATE_DIR = path.join(isolatedHome, ".nexus");
}
