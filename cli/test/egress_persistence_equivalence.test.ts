import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";

// Reference traversal deliberately classifies every repeated scalar independently.
function reference(boundary: InformationFlowBoundary, value: any): any {
  const redact = (text: string) => {
    for (const finding of boundary.classifyText(text)) text = text.replaceAll(finding.secret, `[REDACTED:${finding.patternName || "SECRET"}]`);
    return text;
  };
  const visit = (item: any): any => typeof item === "string" ? redact(item)
    : Array.isArray(item) ? item.map(visit)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, nested]) => [redact(key), visit(nested)])) : item;
  return JSON.parse(redact(JSON.stringify(visit(value))));
}

test("invocation-local reuse preserves contextual, key and serialized redaction", () => {
  const boundary = new InformationFlowBoundary();
  const repeated = "Bearer abcdefghijklmnopqrstuvwxyz123456";
  const value = { messages: [{ role: "tool", content: repeated }, { role: "assistant", content: repeated }],
    api_key: "fixturevalue12345", nested: { 'password="fixturevalue12345"': repeated }, output: "x".repeat(2048) };
  assert.deepEqual(boundary.redactForDurablePersistence(value), reference(boundary, value));
  assert.equal(JSON.stringify(boundary.redactForDurablePersistence(value)).includes("fixturevalue12345"), false);
});

test("redaction reuse never crosses an environment or policy change", () => {
  const boundary = new InformationFlowBoundary();
  const value = { messages: ["ordinary fixture phrase with spaces", "ordinary fixture phrase with spaces"] };
  const before = process.env.NEXUS_TEST_API_KEY;
  try {
    delete process.env.NEXUS_TEST_API_KEY;
    assert.deepEqual(boundary.redactForDurablePersistence(value), value);
    process.env.NEXUS_TEST_API_KEY = value.messages[0];
    assert.equal(JSON.stringify(boundary.redactForDurablePersistence(value)).includes(value.messages[0]), false);
    delete process.env.NEXUS_TEST_API_KEY;
    assert.deepEqual(boundary.redactForDurablePersistence(value), value);
  } finally { if (before === undefined) delete process.env.NEXUS_TEST_API_KEY; else process.env.NEXUS_TEST_API_KEY = before; }
});

test("all contextual key aliases retain classification with case and identifier prefixes", () => {
  const boundary = new InformationFlowBoundary();
  for (const key of ["password", "passwd", "secret", "api_key", "apikey", "access_token", "private_key", "auth_token", "secret_key"]) {
    for (const alias of [key, key.toUpperCase(), `db_${key}`]) {
      const text = `${alias}="fixturevalue12345"`;
      assert.ok(boundary.classifyText(text).some(finding => finding.secret === "fixturevalue12345"), text);
    }
  }
});
