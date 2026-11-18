import { test } from "node:test";
import assert from "node:assert/strict";
import { SANITIZATION_FAILED, redactDiagnosticForOutput } from "../src/core/persistence_protection.js";
import { SANITIZATION_FAILED as FROM_SAFE_TEXT } from "../src/safe_text.js";
import { redactPlain, stripEscapes } from "../src/protocol.js";
import { redactSecrets, safeTerminal } from "../src/ui.js";
import { safeDiffText } from "../src/evidence.js";

const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123";
const CORPUS = ["plain", `key ${KEY}`, `\u001b[31mred ${KEY}\u001b[0m`, "bell\u0007 and \u009b csi ‮ rtl", "Bearer abcdefghijklmnopqrstuvwxyz"];

test("one sanitisation-failure placeholder is shared by every sanitiser", () => {
  assert.equal(FROM_SAFE_TEXT, SANITIZATION_FAILED);
  assert.equal(SANITIZATION_FAILED, "[diagnostic suppressed: credential sanitization failed]");
  assert.equal(redactDiagnosticForOutput("fine"), "fine");
});

test("redactPlain is exactly redactSecrets over stripEscapes", () => {
  for (const text of CORPUS) assert.equal(redactPlain(text), redactSecrets(stripEscapes(text)));
  assert.ok(!redactPlain(CORPUS[2]).includes(KEY));
  assert.ok(!redactPlain(CORPUS[2]).includes("\u001b"));
});

test("safeDiffText is the one terminal-safe helper (safeTerminal)", () => {
  for (const text of CORPUS) assert.equal(safeDiffText(text), safeTerminal(text));
  assert.ok(!safeTerminal(CORPUS[3]).includes("‮"));
});
