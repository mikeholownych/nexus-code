import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPathTokens } from "../src/tester.js";

test("extractPathTokens preserves punctuation and line-column cleanup semantics", () => {
  const tokens = extractPathTokens(
    "/workspace",
    "src/one.ts:12:3, src/two.ts:4; src/three.ts... src/four.ts:12:3:4"
  );

  assert.ok(tokens.has("src/one.ts"));
  assert.ok(tokens.has("src/two.ts"));
  assert.ok(tokens.has("src/three.ts"));
  assert.ok(tokens.has("src/four.ts:12"));
  assert.ok(!tokens.has("src/one.ts:12:3"));
});

test("extractPathTokens handles a long untrusted punctuation suffix", () => {
  const pathToken = `src/${"a".repeat(100_000)}`;
  const output = `${pathToken}${".,;:".repeat(25_000)}`;
  const tokens = extractPathTokens("/workspace", output);

  assert.ok(tokens.has(pathToken));
});
