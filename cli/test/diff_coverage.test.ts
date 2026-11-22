import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseAddedLines, parseLcov } from "../scripts/diff_coverage.mjs";

test("diff coverage reads only added lines from zero-context hunks", () => {
  const diff = [
    "diff --git a/cli/src/a.ts b/cli/src/a.ts",
    "--- a/cli/src/a.ts",
    "+++ b/cli/src/a.ts",
    "@@ -10,2 +10,2 @@",
    "-old line",
    "+new line",
    "@@ -40 +40,3 @@",
    "+first",
    "+second",
    "+third",
    "@@ -80 +82,0 @@",
    "-deleted only",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [10, 40, 41, 42]);
});

test("diff coverage ignores non-instrumented lines and normalises lcov paths", () => {
  const lcov = [
    "TN:",
    "SF:src/protocol.ts",
    "DA:1,1",
    "DA:2,0",
    "DA:3,0",
    "end_of_record",
    "SF:cli/src/other.ts",
    "DA:9,4",
    "end_of_record",
  ].join("\n");
  const hits = parseLcov(lcov);
  assert.deepEqual([...hits.keys()], ["cli/src/protocol.ts", "cli/src/other.ts"]);
  assert.equal(hits.get("cli/src/protocol.ts")!.get(1), 1);
  assert.equal(hits.get("cli/src/protocol.ts")!.get(2), 0);
  assert.equal(hits.get("cli/src/other.ts")!.get(9), 4);
  // A comment/blank line has no DA record and must not count against the gate.
  assert.equal(hits.get("cli/src/protocol.ts")!.has(4), false);
});
