import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { defaultTaskStateDir } from "../src/core/state.js";

// REQ-PER-103: the suite must never touch the operator's home. scripts/run_tests.mjs provides a throwaway HOME and
// names the real one; running the tests any other way fails here instead of silently writing to ~/.nexus.
test("the test suite runs under a throwaway HOME, never the operator's", () => {
  const realHome = process.env.NEXUS_TEST_REAL_HOME;
  assert.ok(realHome, "run the suite through `npm test` (scripts/run_tests.mjs), which isolates HOME");
  const home = os.homedir();
  assert.notEqual(path.resolve(home), path.resolve(realHome));
  assert.ok(!defaultTaskStateDir().startsWith(path.resolve(realHome) + path.sep), "task state would land in the real home");
  assert.equal(process.env.XDG_CONFIG_HOME, path.join(home, ".config"));
});
