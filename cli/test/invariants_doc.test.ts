/** docs/INVARIANTS.md is consistent with the code and tests it names (scripts/check_invariants.mjs). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every invariant row names existing code and a proving test, and code cites only defined rules", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts", "check_invariants.mjs")], { encoding: "utf8" });
  assert.match(out, /invariants: \d+ rows; all referenced source and test files exist/);
});
