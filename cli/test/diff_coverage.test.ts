import { test } from "node:test";
import * as assert from "node:assert/strict";
import path from "node:path";
import { parseAddedLines, parseLcov, resolveDiffBase } from "../scripts/diff_coverage.mjs";
import { optionValue, resolveCoverageOut } from "../scripts/script_args.mjs";

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

test("diff coverage keeps added source lines that themselves begin with ++", () => {
  const diff = [
    "diff --git a/cli/src/a.ts b/cli/src/a.ts",
    "--- a/cli/src/a.ts",
    "+++ b/cli/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+++typed line",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [1]);
});

test("script options reject a missing value instead of consuming the next flag", () => {
  assert.equal(optionValue(["node", "run.mjs", "--out", "report.info"], "out", "fallback"), "report.info");
  assert.equal(optionValue(["node", "run.mjs", "--out", "--tier=unit"], "out", "fallback"), "fallback");
  assert.equal(optionValue(["node", "run.mjs", "--out=report.info"], "out", "fallback"), "report.info");
  assert.equal(optionValue(["node", "run.mjs"], "out", "fallback"), "fallback");
  assert.equal(resolveCoverageOut(["node", "run.mjs"], {}, "/repo/cli"), path.join("/repo/cli", "coverage", "lcov.info"));
  assert.equal(resolveCoverageOut(["node", "run.mjs"], { NEXUS_COVERAGE_OUT: "custom.info" }, "/repo/cli"), path.join("/repo/cli", "custom.info"));
  assert.equal(resolveCoverageOut(["node", "run.mjs", "--out", "flag.info"], { NEXUS_COVERAGE_OUT: "env.info" }, "/repo/cli"), path.join("/repo/cli", "flag.info"));
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


test("diff coverage treats missing or all-zero base as unavailable, not a git diff error", () => {
  assert.deepEqual(resolveDiffBase("", () => { throw new Error("should not run"); }), { base: null, reason: "no base revision available" });
  assert.deepEqual(resolveDiffBase("0000000000000000000000000000000000000000", () => { throw new Error("should not run"); }), { base: null, reason: "no base revision available" });
  assert.deepEqual(resolveDiffBase("deadbeef", () => { throw new Error("fatal: bad object deadbeef"); }), { base: null, reason: "fatal: bad object deadbeef" });
  assert.deepEqual(resolveDiffBase("abc123", () => "abc123\n"), { base: "abc123", reason: null });
});
