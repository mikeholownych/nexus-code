import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import "./helpers/leak_guard.js";
import { executeSideQuestion } from "../src/side_question.js";
import type { ChatMessage, HarnessConfig, ToolDefinition } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-side-question-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = previous;
  });
  const workspace = path.join(root, "checkout");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, ".nexus"));
  fs.writeFileSync(path.join(workspace, ".nexus", "knowledge.json"), "ACTIVE-MEMORY-MARKER");
  fs.writeFileSync(path.join(workspace, "README.md"), "Run make check for this repository.\n");
  fs.writeFileSync(path.join(root, "objective.json"), "ACTIVE-OBJECTIVE-MARKER");
  fs.writeFileSync(path.join(root, "acceptance.json"), "ACTIVE-ACCEPTANCE-MARKER");
  const config = (endpoint: string): HarnessConfig => ({
    workspace, endpoint, model: "side-fixture", maxSteps: 1, temperature: 0, shell: "bash",
  });
  return { root, workspace, config };
}

type WireRequest = { messages: ChatMessage[]; tools?: ToolDefinition[] };

test("side questions use only the explicit question and transient bounded read results", async (t) => {
  const { root, workspace, config } = fixture(t);
  const server = await startGateway((call) => call === 1
    ? { kind: "tools", calls: [{ id: "read-doc", name: "read_file", args: { path: "README.md" } }] }
    : { kind: "text", content: "Use make check." });
  t.after(() => server.close());
  const result = await executeSideQuestion("What command is documented in README.md?", config(server.url));
  assert.deepEqual(result, { success: true, output: "Use make check." });
  assert.equal(server.requests.length, 2);
  const [initial, followup] = server.requests as WireRequest[];
  assert.deepEqual(initial.messages.map((message) => message.role), ["system", "user"]);
  assert.equal(initial.messages[1].content, "What command is documented in README.md?");
  assert.deepEqual(initial.tools?.map((tool) => tool.function.name), ["read_file"]);
  assert.deepEqual(followup.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.match(String(followup.messages[3].content), /make check/);
  assert.doesNotMatch(JSON.stringify(server.requests), /ACTIVE-(?:MEMORY|OBJECTIVE|ACCEPTANCE)-MARKER/);
  assert.deepEqual(fs.readdirSync(root).sort(), ["acceptance.json", "checkout", "objective.json"]);
  assert.deepEqual(fs.readdirSync(path.join(workspace, ".nexus")), ["knowledge.json"]);
  assert.equal(fs.readFileSync(path.join(root, "objective.json"), "utf8"), "ACTIVE-OBJECTIVE-MARKER");
  assert.equal(fs.readFileSync(path.join(root, "acceptance.json"), "utf8"), "ACTIVE-ACCEPTANCE-MARKER");
  await executeSideQuestion("Second isolated question", config(server.url));
  const separate = server.requests[2] as WireRequest;
  assert.deepEqual(separate.messages.map(({ role }) => role), ["system", "user"]);
  assert.equal(separate.messages[1].content, "Second isolated question");
  assert.doesNotMatch(JSON.stringify(separate.messages), /make check|README\.md/);
});

test("side-question tools cannot mutate or read protected and redirected paths", async (t) => {
  const { root, workspace, config } = fixture(t);
  fs.symlinkSync(path.join(root, "objective.json"), path.join(workspace, "outside"));
  const server = await startGateway((call) => call <= 2
    ? { kind: "tools", calls: [{ id: `read-${call}`, name: "read_file", args: { path: call === 1 ? ".nexus/knowledge.json" : "outside" } }] }
    : { kind: "tools", calls: [{ id: "write-repo", name: "write_file", args: { path: "unexpected", content: "side effect" } }] });
  t.after(() => server.close());
  await assert.rejects(executeSideQuestion("Read any required documents.", config(server.url)), /read-only|read budget/i);
  assert.equal(server.requests.length, 3);
  const requests = server.requests as WireRequest[];
  assert.match(String(requests[1].messages[3].content), /outside the allowed read scope/);
  assert.match(String(requests[2].messages[5].content), /outside the allowed read scope/);
  assert.deepEqual(requests[2].tools ?? [], []);
  assert.doesNotMatch(JSON.stringify(server.requests), /ACTIVE-(?:MEMORY|OBJECTIVE|ACCEPTANCE)-MARKER/);
  assert.equal(fs.existsSync(path.join(workspace, "unexpected")), false);
});

test("cancelled and overlong questions fail before inference", async (t) => {
  const { config } = fixture(t);
  const server = await startGateway(() => ({ kind: "text", content: "No request expected." }));
  t.after(() => server.close());
  await assert.rejects(executeSideQuestion("Already cancelled", config(server.url), AbortSignal.abort()), /abort/i);
  await assert.rejects(executeSideQuestion("x".repeat(65_537), config(server.url)), /too long/i);
  assert.equal(server.requests.length, 0);
});


test("side questions obey explicit cloud disclosure policy and do not fail over", async (t) => {
  const { config } = fixture(t);
  const primary = await startGateway(() => ({ kind: "http", status: 429, body: '{"error":"fixture throttled"}' }));
  t.after(() => primary.close());
  const fallback = await startGateway(() => ({ kind: "text", content: "Unexpected fallback." }));
  t.after(() => fallback.close());
  const origin = new URL(primary.url).origin;
  const settings = { ...config(primary.url), fallbackEndpoints: [fallback.url], cloudRoutedOrigins: [origin] };
  await assert.rejects(executeSideQuestion("Private side question", {
    ...settings, authorizedDisclosureOrigins: [],
  }), /unauthorized|has not authorized/i);
  assert.equal(primary.requests.length, 0);
  await assert.rejects(executeSideQuestion("Private side question", {
    ...settings, authorizedDisclosureOrigins: [origin],
  }), /429|throttl/i);
  assert.equal(primary.requests.length, 1);
  assert.equal(fallback.requests.length, 0);
});
