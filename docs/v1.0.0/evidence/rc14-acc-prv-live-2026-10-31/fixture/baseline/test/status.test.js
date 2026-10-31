import test from "node:test";
import assert from "node:assert/strict";
import { classifyStatus } from "../src/status.js";

test("2xx responses remain successful", () => assert.equal(classifyStatus(200), "success"));
test("5xx responses remain retryable", () => assert.equal(classifyStatus(503), "retry"));
test("429 is retryable while other 4xx responses remain failures", () => {
  assert.equal(classifyStatus(429), "retry");
  assert.equal(classifyStatus(404), "failure");
  assert.equal(classifyStatus(418), "failure");
});
