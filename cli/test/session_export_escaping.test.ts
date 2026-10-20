/**
 * Regression test for the session-export Markdown table cell escape (CodeQL
 * js/incomplete-sanitization, cli/src/session_export.ts). A cell value must not be able to
 * break out of its column via an unescaped pipe, and an existing backslash must be escaped
 * before the pipe so it cannot cancel the pipe escape.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeTableCell } from "../src/session_export.js";

describe("escapeTableCell", () => {
  test("escapes pipes so they cannot split a table row", () => {
    assert.equal(escapeTableCell("a | b"), "a \\| b");
  });

  test("escapes backslashes before pipes so a trailing backslash cannot cancel the pipe escape", () => {
    assert.equal(escapeTableCell("a\\| b"), "a\\\\\\| b");
  });

  test("leaves ordinary text untouched", () => {
    assert.equal(escapeTableCell("plain text"), "plain text");
  });

  test("normalizes newlines to spaces so they cannot terminate a table row", () => {
    assert.equal(escapeTableCell("a\nb"), "a b");
    assert.equal(escapeTableCell("a\r\nb"), "a b");
    assert.equal(escapeTableCell("a\rb"), "a b");
  });

  test("escapes pipe and backslash in requirement id and status cells too", () => {
    assert.equal(escapeTableCell("req-1 | injected"), "req-1 \\| injected");
    assert.equal(escapeTableCell("pass\\fail"), "pass\\\\fail");
  });
});
