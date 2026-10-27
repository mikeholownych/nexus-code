import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";

test("lowercases ASCII only and collapses non-alphanumeric runs", () => {
  assert.equal(slugify(" Hello, World! "), "hello-world");
  assert.equal(slugify("R&D + Tools"), "r-d-tools");
  assert.equal(slugify("Crème brûlée"), "cr-me-br-l-e");
  assert.equal(slugify("İ"), "");
  assert.equal(slugify("A🙂B"), "a-b");
  assert.equal(slugify("---"), "");
});
