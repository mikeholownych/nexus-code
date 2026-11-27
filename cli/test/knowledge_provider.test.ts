import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./helpers/leak_guard.js";
import { executeKnowledgeSuggestionCommand } from "../src/knowledge_command.js";
import type { HarnessConfig } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

test("knowledge routes local first and records explicitly authorized cloud fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = previous;
  });
  const workspace = path.join(root, "checkout");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init");
  git("-c", "user.name=Nexus Fixture", "-c", "user.email=nexus@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const sessionId = "session_20261127_080000_fixture";
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { mode: 0o700 });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify({
    sessionId, workspace, workspacePath: workspace, status: "completed",
    messages: [{ role: "user", content: "Use make test for unit tests." }],
  }), { mode: 0o600 });
  const body = { category: "rule", key: "test-locally", value: "Use make test.", sourceRefs: [`${sessionId}:0`] };
  const local = await startGateway((call) => call === 1
    ? { kind: "text", content: JSON.stringify(body) }
    : call === 4 ? { kind: "text", content: "invalid proposal" }
      : { kind: "http", status: 429, body: '{"error":"rate limited"}' });
  t.after(() => local.close());
  const cloud = await startGateway((call) => ({
    kind: "text", content: JSON.stringify({ ...body, key: call === 1 ? "test-on-cloud" : "test-with-cloud-only" }),
  }));
  t.after(() => cloud.close());
  const origin = new URL(cloud.url).origin;
  const config: HarnessConfig = {
    workspace, endpoint: cloud.url, model: "cloud-fixture", plannerEndpoint: local.url, plannerModel: "local-fixture",
    contextLimit: 8192, cloudRoutedOrigins: [origin], authorizedDisclosureOrigins: [origin],
    maxSteps: 1, shell: "bash", temperature: 0,
  };
  const invoke = (args: string, effective = config) => executeKnowledgeSuggestionCommand(args, effective, { workspaceTrusted: true });
  const suggest = async (effective = config) => {
    const result = await invoke(`suggest ${sessionId}`, effective);
    assert.equal(result?.success, true);
    const id = result?.output.match(/^[a-f0-9]{64}/)?.[0];
    assert.ok(id);
    return { result, suggestion: JSON.parse((await invoke(`show-suggestion ${id}`))!.output) };
  };

  const first = await suggest();
  assert.deepEqual(first.suggestion.inference, {
    resourceId: "planner", model: "local-fixture", disclosure: "local", policy: "local_preferred",
  });
  assert.equal(local.requests.length, 1);
  assert.equal(cloud.requests.length, 0);

  await assert.rejects(suggest({ ...config, authorizedDisclosureOrigins: [] }), /rate limit/i);
  assert.equal(cloud.requests.length, 0);
  const fallback = await suggest();
  assert.deepEqual(fallback.suggestion.inference, {
    resourceId: "primary", model: "cloud-fixture", disclosure: "cloud", fallbackFrom: "planner",
    policy: "operator_authorized_origin", authorizedOrigin: origin, fallbackReason: "local_resource_failed",
  });
  assert.match(fallback.result.output, /cloud/);
  assert.equal(cloud.requests.length, 1);
  const post = cloud.requests[0] as { messages: Array<{ role: string; content: string }>; tools?: unknown[] };
  assert.deepEqual(post.messages.map((message) => message.role), ["system", "user"]);
  assert.match(post.messages[1].content, /Use make test for unit tests/);
  assert.deepEqual(post.tools ?? [], []);
  await assert.rejects(suggest(), /not valid JSON/);
  assert.equal(cloud.requests.length, 1, "invalid model output must not trigger disclosure");
  await assert.rejects(suggest({ ...config, contextLimit: 128 }), /eligible.*resource/i);
  assert.equal(cloud.requests.length, 1);
  assert.equal(local.requests.length, 4);
  const cloudOnly = await suggest({ ...config, plannerEndpoint: undefined, plannerModel: undefined });
  assert.deepEqual(cloudOnly.suggestion.inference, {
    resourceId: "primary", model: "cloud-fixture", disclosure: "cloud", policy: "operator_authorized_origin",
    authorizedOrigin: origin, fallbackReason: "no_eligible_local_resource",
  });
  assert.equal(cloud.requests.length, 2);
  assert.deepEqual(fs.readdirSync(workspace), [".git"]);
});
