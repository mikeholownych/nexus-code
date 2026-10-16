/**
 * Small provider fixes (PLAN-05 PR-5c): a content filter ending a Responses reply is a refusal, not an interrupted
 * stream to retry (PRV-16); a key-less compatible server the operator declared is listed as connected (PRV-14).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResponsesResponse } from "../src/protocols/openai_responses.js";
import { connectionOf } from "../src/model_catalog.js";

test("a Responses reply stopped by a content filter is a refusal; one cut at the output limit is truncation", () => {
  const output = [{ type: "message", content: [{ type: "output_text", text: "partial" }] }];
  assert.equal(parseResponsesResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output }, "openai", false).finish, "refusal");
  assert.equal(parseResponsesResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output }, "openai", false).finish, "length");
});

test("a compatible server declared key-less by the operator is connected (PRV-14)", () => {
  const saved = { auth: process.env.NEXUS_COMPATIBLE_AUTH, url: process.env.NEXUS_COMPATIBLE_BASE_URL, key: process.env.NEXUS_COMPATIBLE_API_KEY };
  try {
    delete process.env.NEXUS_COMPATIBLE_API_KEY;
    process.env.NEXUS_COMPATIBLE_BASE_URL = "http://127.0.0.1:8000/v1";
    delete process.env.NEXUS_COMPATIBLE_AUTH;
    assert.equal(connectionOf("compatible").connected, false);
    process.env.NEXUS_COMPATIBLE_AUTH = "none";
    const c = connectionOf("compatible");
    assert.equal(c.connected, true);
    assert.match(String(c.source), /NEXUS_COMPATIBLE_AUTH=none/);
  } finally {
    for (const [k, v] of [["NEXUS_COMPATIBLE_AUTH", saved.auth], ["NEXUS_COMPATIBLE_BASE_URL", saved.url], ["NEXUS_COMPATIBLE_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
