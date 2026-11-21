/**
 * A coloured type-check failure is still a failure. With FORCE_COLOR=1 in the operator's environment tsc wraps the file,
 * line and column in escape sequences; the parser then located no file and classifyTypecheck answered ENVIRONMENT
 * ("the check could not run"), which does not block completion. The sample below is real `tsc` output.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyTypecheck, parseTypecheckDiagnostics } from "../src/tester.js";

const E = "\x1b";
const COLOURED = `${E}[96ma.ts${E}[0m:${E}[93m1${E}[0m:${E}[93m7${E}[0m - ${E}[91merror${E}[0m${E}[90m TS2322: ${E}[0mType 'string' is not assignable to type 'number'.\n\n${E}[7m1${E}[0m const x: number = "s";\n${E}[7m ${E}[0m ${E}[91m      ~${E}[0m\n\n\nFound 1 error in a.ts${E}[90m:1${E}[0m\n\n`;
const PLAIN = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
const check = { tool: "tsc", configPath: "tsconfig.json" } as const;

describe("type-check output with terminal colour", () => {
  test("the coloured form locates the same file and error as the plain form", () => {
    const coloured = parseTypecheckDiagnostics(COLOURED);
    const plain = parseTypecheckDiagnostics(PLAIN);
    assert.deepEqual(coloured.files, ["a.ts"]);
    assert.deepEqual(coloured.files, plain.files);
    assert.equal(coloured.errorCount, 1);
    assert.ok(!JSON.stringify(coloured).includes("\\u001b"), "no escape sequence survives into the diagnostics");
  });

  test("a coloured error in a modified file is FAILED, not ENVIRONMENT; in an untouched file with a clean baseline it is FAILED too", () => {
    assert.equal(classifyTypecheck(check, COLOURED, "/ws", new Set(["/ws/a.ts"])).status, "FAILED");
    assert.equal(classifyTypecheck(check, COLOURED, "/ws", new Set(), new Set()).status, "FAILED", "new against an empty baseline");
    // Baseline: the plain form already behaved this way.
    assert.equal(classifyTypecheck(check, PLAIN, "/ws", new Set(["/ws/a.ts"])).status, "FAILED");
  });

  test("an error the baseline already had stays PREEXISTING whether or not either run was coloured", () => {
    const baseline = new Set(classifyTypecheck(check, PLAIN, "/ws", new Set(["/ws/a.ts"])).signatures);
    assert.equal(classifyTypecheck(check, COLOURED, "/ws", new Set(), baseline).status, "PREEXISTING", "the coloured signature equals the plain one");
  });

  test("output with no located error is still ENVIRONMENT (colour is not what decides it)", () => {
    assert.equal(classifyTypecheck(check, `${E}[91merror${E}[0m TS5083: Cannot read file 'tsconfig.json'.\n`, "/ws", new Set(["/ws/a.ts"])).status, "ENVIRONMENT");
  });
});
