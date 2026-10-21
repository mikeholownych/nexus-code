/**
 * Regression tests for converting single-quoted JSON (model output) into double-quoted JSON
 * without corrupting string contents or allowing a backslash to break out of the literal
 * (CodeQL js/incomplete-sanitization, cli/src/parser.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { repairJson, unescapeSingleQuoteBody } from "../src/parser.js";

describe("single-quoted JSON repair", () => {
  test("preserves valid JSON escapes", () => {
    assert.equal(unescapeSingleQuoteBody("line1\\nline2"), "line1\\nline2");
    assert.equal(repairJson("{'msg': 'say \\\"hi\\\"'}").msg, 'say "hi"');
  });

  test("escapes a bare backslash such as a Windows path separator", () => {
    const repaired = repairJson("{'path': 'C:\\Users\\me'}");
    assert.equal(repaired.path, "C:\\Users\\me");
  });

  test("unescapes a single-quote escape, which is invalid in JSON", () => {
    assert.equal(repairJson("{'msg': 'it\\'s'}").msg, "it's");
  });

  test("a trailing backslash cannot break out of the string", () => {
    assert.equal(unescapeSingleQuoteBody("x\\"), "x\\\\");
  });

  test("valid \\uXXXX unicode escapes are preserved as JSON escapes", () => {
    assert.equal(unescapeSingleQuoteBody("\\u0041"), "\\u0041");
  });

  test("invalid \\u followed by non-hex escapes the backslash instead of emitting Bad Unicode escape", () => {
    assert.equal(unescapeSingleQuoteBody("\\ux"), "\\\\ux");
    assert.equal(unescapeSingleQuoteBody("C:\\users"), "C:\\\\users");
  });
});
