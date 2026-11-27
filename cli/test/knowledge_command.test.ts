import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeKnowledgeSuggestionCommand } from "../src/knowledge_command.js";
import type { HarnessConfig } from "../src/types.js";

test("operator suggestion command validates selected sources and preserves review authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-knowledge-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prior = process.env.NEXUS_STATE_DIR;
  process.env.NEXUS_STATE_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.NEXUS_STATE_DIR;
    else process.env.NEXUS_STATE_DIR = prior;
  });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
  git("init");
  git("-c", "user.name=Nexus Fixture", "-c", "user.email=nexus@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const sessionId = "session_20261127_080000_fixture";
  const sourceRef = `${sessionId}:0`;
  const dir = path.join(root, "sessions");
  fs.mkdirSync(dir, { mode: 0o700 });
  const sessionFile = path.join(dir, `${sessionId}.json`);
  const session = {
    sessionId, workspace, workspacePath: workspace, status: "completed",
    messages: [{ role: "user", content: "Use make test." }],
  };
  const saveSession = () => fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
  saveSession();
  const config = { workspace, endpoint: "http://127.0.0.1:1234/v1", model: "fixture" } as HarnessConfig;
  const response = { key: "test-command", value: "Use make test.", category: "rule", sourceRefs: [sourceRef] };
  let output: unknown = { ...response, sourceRefs: ["forged:1"] };
  let calls = 0;
  const call = (arg: string, settings = config) => executeKnowledgeSuggestionCommand(arg, settings, {
    workspaceTrusted: true,
    actor: "local operator",
    generate: async (_contract, input) => {
      calls++;
      assert.match(input, /Use make test/);
      return output;
    },
  });
  await assert.rejects(call(`suggest ${sessionId}`), /selected source/);
  assert.equal(calls, 1);
  await assert.rejects(call(`suggest ${sessionId}`, { ...config, provider: "irrelevant-cloud" }), /local inference/);
  await assert.rejects(call(`suggest ${sessionId}`, { ...config, readOnly: true }), /Read-only/);
  assert.equal(calls, 1);
  output = response;
  const result = await call(`suggest ${sessionId}`);
  const id = result?.output.match(/^[a-f0-9]{64}/)?.[0];
  assert.ok(id);
  await assert.rejects(call(`promote ${id}`), /Cannot transition/);
  assert.match((await call(`review ${id}`))!.output, /reviewed/);
  assert.match((await call(`promote ${id}`))!.output, /promoted/);
  assert.match((await call("suggestions"))!.output, /promoted/);
  fs.unlinkSync(sessionFile);
  assert.match((await call(`show-suggestion ${id}`))!.output, /unknown/);
  assert.match((await call(`delete-suggestion ${id}`))!.output, /deleted/);
});
