import { test } from "node:test";
import assert from "node:assert/strict";
import { isContinuationPrompt } from "../src/core/objective.js";

test("continuation prompt strips only the same trailing punctuation", () => {
  assert.equal(isContinuationPrompt("continue.!…"), true);
  assert.equal(isContinuationPrompt("continue! with the README instead!!!"), false);
  assert.equal(isContinuationPrompt("continue?"), false);
});

test("continuation prompt handles long untrusted punctuation suffixes", () => {
  assert.equal(isContinuationPrompt(`continue${".!…".repeat(100_000)}`), true);
});
