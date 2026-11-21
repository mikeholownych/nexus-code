import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./helpers/leak_guard.js";
import { BatchOrchestrator } from "../src/batch.js";
import { OperationStore } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";
import { startGateway } from "./helpers/fixtures.js";

test("durable batch executes through a minimal OpenAI-compatible chat contract", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-provider-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-provider-workspace-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-batch-provider-state-"));
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR,
  };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  const gateway = await startGateway(() => ({
    kind: "tools",
    calls: [{ name: "task_completed", args: { summary: "The requested inspection is complete." } }],
  }));

  try {
    const config: HarnessConfig = {
      endpoint: gateway.url,
      model: "fixture-model",
      maxSteps: 2,
      temperature: 0,
      workspace,
      shell: "bash",
      approvalMode: "auto",
      fullAccess: true,
    };
    const resource: ResourceDescriptor = {
      id: "standard-openai-compatible",
      provider: gateway.url.replace(/\/v1\/?$/, ""),
      endpoint: gateway.url,
      model: config.model,
      capabilities: ["tools"],
      rank: 0,
    };
    const store = new OperationStore(workspace, stateDir);
    const batch = new BatchOrchestrator(config, { store, resources: [resource] });
    const result = await batch.run({
      id: "minimal-provider",
      objective: "Inspect the workspace and report completion.",
      units: [{ id: "inspect", role: "researcher", prompt: "Inspect the workspace and report completion." }],
    });

    assert.equal(result.status, "COMPLETE", JSON.stringify(result.operation.units.map((unit) => ({ status: unit.status, blocked: unit.blocked, result: unit.result }))));
    assert.equal(store.load("batch-minimal-provider").status, "COMPLETE");
    assert.equal(gateway.requests.length, 1);
    const request = gateway.requests[0] as { model: string; messages: unknown[]; stream: boolean; tools: unknown[] };
    assert.equal(request.model, "fixture-model");
    assert.ok(Array.isArray(request.messages));
    assert.equal(request.stream, true);
    assert.ok(request.tools.some((tool: any) => tool.function?.name === "task_completed"));
    assert.ok(!("nexus_capabilities" in request));
    assert.ok(!("queue" in request));
    assert.match(gateway.authSeen[0]?.authorization ?? "", /^Bearer /, "the request uses only the standard bearer-auth contract");
  } finally {
    await gateway.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
