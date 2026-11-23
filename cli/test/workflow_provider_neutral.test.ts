import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import "./helpers/leak_guard.js";
import { LoopOrchestrator } from "../src/loop.js";
import { GoalOrchestrator } from "../src/goal.js";
import { OperationStore } from "../src/core/operation_runner.js";
import type { ResourceDescriptor } from "../src/core/resources.js";
import type { HarnessConfig } from "../src/types.js";
import { makeRepo, startGateway, type Reply } from "./helpers/fixtures.js";

function toolNames(body: any): Set<string> {
  return new Set((body?.tools ?? []).map((tool: any) => tool?.function?.name).filter((name: unknown): name is string => typeof name === "string"));
}

function called(messages: any[], name: string): boolean {
  return messages.some((message) => message?.role === "assistant" && message.tool_calls?.some((call: any) => call?.function?.name === name));
}

function responseFor(body: any): Reply {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const prompt = messages.map((message: any) => typeof message?.content === "string" ? message.content : "").join("\n");
  const available = toolNames(body);
  if (prompt.includes("### Specialized Role: TESTER") && available.has("run_tests") && !called(messages, "run_tests")) {
    return { kind: "tools", calls: [{ name: "run_tests", args: {} }] };
  }
  if (prompt.includes("### Specialized Role: IMPLEMENTER") && available.has("write_file") && !called(messages, "write_file")) {
    return { kind: "tools", calls: [{ name: "write_file", args: { path: "src/provider-proof.js", content: 'export function proof() { return "standard-wire workflow verified"; }\n', overwrite: true } }] };
  }
  if (prompt.includes("### Specialized Role: IMPLEMENTER") && available.has("update_requirements") && !called(messages, "update_requirements")) {
    return { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "implemented", evidence: ["The workspace acceptance fixture is implemented."] }] } }] };
  }
  if (prompt.includes("### Specialized Role: TESTER") && available.has("update_requirements") && called(messages, "run_tests") && !called(messages, "update_requirements")) {
    return { kind: "tools", calls: [{ name: "update_requirements", args: { requirements: [{ id: "R1", status: "verified", evidence: ["The deterministic workspace test suite passed."] }] } }] };
  }
  const summary = prompt.includes("INSTRUCTIONS FOR INDEPENDENT REVIEWER")
    ? JSON.stringify({
        verdict: "ACCEPT",
        verifiedObservations: ["The deterministic verifier passed on the changed module."],
        suspectedDefects: [],
        unprovenCriteria: [],
        scopeViolations: [],
        reviewerConfidenceNote: "The available objective evidence supports acceptance.",
        changeAssessment: {
          purpose: "Update the fixture module to satisfy the acceptance test.",
          evidence: "The verifier output records one passing test.",
          boundaryImpact: "Only the declared fixture module changed.",
          invariantImpact: "No execution or authority invariant changed.",
          failureBehaviour: "A failing verifier prevents acceptance.",
          maintainabilityImpact: "The change remains isolated to the test fixture.",
          validation: "The configured npm test command passed.",
          residualRisk: "The fixture is synthetic and validates transport behavior only.",
        },
      })
    : "Completed the assigned workflow task with the available evidence.";
  return { kind: "tools", calls: [{ name: "task_completed", args: { summary } }] };
}

function setup(label: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-${label}-home-`));
  const workspace = makeRepo({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "env -u NODE_TEST_CONTEXT node --test test/provider.test.js" } }),
    "src/provider-proof.js": 'export function proof() { return "baseline"; }\n',
    "test/provider.test.js": "import test from 'node:test'; import assert from 'node:assert/strict'; import { proof } from '../src/provider-proof.js'; test('provider-neutral workflow verifier', () => assert.equal(proof(), 'standard-wire workflow verified'));\n",
  });
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.NEXUS_STATE_DIR = path.join(home, ".nexus");
  const config: HarnessConfig = {
    endpoint: "",
    model: "fixture-model-a",
    maxSteps: 10,
    temperature: 0,
    workspace,
    shell: "bash",
    approvalMode: "auto",
    fullAccess: true,
    trustedDeliverableFiles: ["src/provider-proof.js"],
    // This command performs a real workspace assertion and emits a recognized test count for Nexus' verifier parser.
    authoritativeVerifierCommand: "npm test",
    verifierTimeoutSecs: 15,
  };
  const store = new OperationStore(workspace, path.join(home, ".nexus", "tasks"));
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const configureGateway = async () => {
    gateway = await startGateway((_n, body) => responseFor(body));
    config.endpoint = gateway.url;
    return gateway;
  };
  const resources: ResourceDescriptor[] = ["fixture-model-a", "fixture-model-b"].map((model, rank) => ({
    id: `standard-${model}`,
    provider: "standard-openai-compatible",
    endpoint: "",
    model,
    capabilities: ["tools"],
    qualifications: ["research", "architecture", "implementation", "verification", "review"],
    maxConcurrentUnits: 1,
    rank,
  }));
  const cleanup = async () => {
    await gateway?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  };
  return { config, resources, store, configureGateway, cleanup, workspace };
}

function assertStandardContract(gateway: NonNullable<Awaited<ReturnType<typeof startGateway>>>) {
  assert.ok(gateway.requests.length > 0, "the workflow must reach the ordinary chat endpoint");
  assert.ok(gateway.requests.every((request: any) => request.model && Array.isArray(request.messages) && request.stream === true));
  assert.ok(gateway.requests.every((request: any) => !("nexus_capabilities" in request) && !("queue" in request)));
  assert.ok(gateway.authSeen.every((entry) => entry.path.endsWith("/models") || entry.authorization?.startsWith("Bearer ")));
  assert.ok(!gateway.authSeen.some((entry) => entry.path.includes("/tokenize")), "missing token-counting extension must not block workflow execution");
}

function anthropicPrompt(body: any): string {
  const system = Array.isArray(body?.system) ? body.system.map((block: any) => block?.text) : [body?.system];
  const values = [...system, ...(Array.isArray(body?.messages) ? body.messages.flatMap((message: any) => Array.isArray(message?.content) ? message.content.map((block: any) => block?.text) : [message?.content]) : [])];
  return values.filter((value): value is string => typeof value === "string").join("\n");
}

function anthropicCalled(messages: any[], name: string): boolean {
  return messages.some((message) => message?.role === "assistant" && Array.isArray(message.content) && message.content.some((block: any) => block?.type === "tool_use" && block.name === name));
}

function anthropicReview(prompt: string): string {
  return JSON.stringify({
    verdict: "ACCEPT",
    verifiedObservations: ["The deterministic verifier passed on the changed module."],
    suspectedDefects: [],
    unprovenCriteria: [],
    scopeViolations: [],
    reviewerConfidenceNote: "The available objective evidence supports acceptance.",
    changeAssessment: {
      purpose: "Update the fixture module to satisfy the acceptance test.",
      evidence: "The verifier output records one passing test.",
      boundaryImpact: "Only the declared fixture module changed.",
      invariantImpact: "No execution or authority invariant changed.",
      failureBehaviour: "A failing verifier prevents acceptance.",
      maintainabilityImpact: "The change remains isolated to the test fixture.",
      validation: "The configured npm test command passed.",
      residualRisk: "The fixture is synthetic and validates transport behavior only.",
    },
  });
}

async function startAnthropicGateway() {
  const requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fixture-anthropic-a" }, { id: "fixture-anthropic-b" }] }));
        return;
      }
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const prompt = anthropicPrompt(body);
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const available = new Set(tools.map((tool: any) => tool.name).filter((name: unknown): name is string => typeof name === "string"));
      let tool: { name: string; input: Record<string, unknown> };
      if (prompt.includes("### Specialized Role: IMPLEMENTER") && available.has("write_file") && !anthropicCalled(messages, "write_file")) {
        tool = { name: "write_file", input: { path: "src/provider-proof.js", content: 'export function proof() { return "standard-wire workflow verified"; }\n', overwrite: true } };
      } else if (prompt.includes("### Specialized Role: IMPLEMENTER") && available.has("update_requirements") && !anthropicCalled(messages, "update_requirements")) {
        tool = { name: "update_requirements", input: { requirements: [{ id: "R1", status: "implemented", evidence: ["The workspace acceptance fixture is implemented."] }] } };
      } else if (prompt.includes("### Specialized Role: TESTER") && available.has("run_tests") && !anthropicCalled(messages, "run_tests")) {
        tool = { name: "run_tests", input: {} };
      } else if (prompt.includes("### Specialized Role: TESTER") && available.has("update_requirements") && anthropicCalled(messages, "run_tests") && !anthropicCalled(messages, "update_requirements")) {
        tool = { name: "update_requirements", input: { requirements: [{ id: "R1", status: "verified", evidence: ["The deterministic workspace test suite passed."] }] } };
      } else {
        const summary = prompt.includes("INSTRUCTIONS FOR INDEPENDENT REVIEWER")
          ? anthropicReview(prompt)
          : "Completed the assigned workflow task with the available evidence.";
        tool = { name: "task_completed", input: { summary } };
      }
      const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const stream = [
        event({ type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 1 } } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_${requests.length}`, name: tool.name, input: {} } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        event({ type: "message_stop" }),
      ].join("");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("bounded loop lifecycle runs on a minimal OpenAI-compatible endpoint without provider extensions", async () => {
  const f = setup("loop-provider");
  const gateway = await f.configureGateway();
  try {
    const result = await new LoopOrchestrator(f.config, {
      store: f.store,
      resources: f.resources.map((resource) => ({ ...resource, endpoint: gateway.url })),
      maxInProcessWaitMs: 30_000,
    }).start("Implement the provider-neutral fixture task and verify the required artifact with the configured deterministic verifier.", {
      condition: { kind: "verification", command: f.config.authoritativeVerifierCommand! },
      maxIterations: 1,
      maxDurationMs: 300_000,
    });
    assert.equal(result.status, "COMPLETE", `${result.state.reason ?? ""}\n${JSON.stringify(result.state.iterations)}`);
    assertStandardContract(gateway);
    assert.ok(gateway.requests.some((request: any) => request.model === "fixture-model-a"));
    assert.ok(gateway.requests.some((request: any) => request.model === "fixture-model-b"), "independent review uses another configured model identity");
  } finally { await f.cleanup(); }
});

test("bounded loop runs through the existing Anthropic messages adapter without Nexus-specific headers", async () => {
  const f = setup("loop-anthropic-provider");
  const gateway = await startAnthropicGateway();
  process.env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
  f.config.provider = "anthropic";
  f.config.endpoint = gateway.endpoint;
  try {
    const result = await new LoopOrchestrator(f.config, {
      store: f.store,
      resources: ["fixture-anthropic-a", "fixture-anthropic-b"].map((model, rank) => ({
        id: model,
        provider: "anthropic",
        providerId: "anthropic",
        endpoint: gateway.endpoint,
        model,
        capabilities: ["tools"],
        qualifications: ["research", "architecture", "implementation", "verification", "review"],
        maxConcurrentUnits: 1,
        rank,
      })),
      maxInProcessWaitMs: 30_000,
    }).start("Implement the provider-neutral fixture task and verify the required artifact with the configured deterministic verifier.", {
      condition: { kind: "verification", command: f.config.authoritativeVerifierCommand! },
      maxIterations: 1,
      maxDurationMs: 300_000,
    });
    assert.equal(result.status, "COMPLETE", `${result.state.reason ?? ""}\n${JSON.stringify(result.state.iterations)}`);
    assert.ok(gateway.requests.length > 0);
    assert.ok(gateway.requests.every((request) => request.path === "/v1/messages"));
    assert.ok(gateway.requests.every((request) => request.headers["x-api-key"] === "fixture-anthropic-key"));
    assert.ok(gateway.requests.every((request) => request.headers["anthropic-version"] === "2023-06-01"));
    assert.ok(gateway.requests.every((request) => request.headers.authorization === undefined && request.headers["x-task-class"] === undefined));
    assert.ok(gateway.requests.some((request) => request.body.model === "fixture-anthropic-a"));
    assert.ok(gateway.requests.some((request) => request.body.model === "fixture-anthropic-b"), "independent review uses the second configured model identity");
  } finally {
    await gateway.close();
    await f.cleanup();
  }
});

test("durable goal seeds implementer and tester ledgers through the standard provider contract", async () => {
  const f = setup("goal-ledger-provider");
  const gateway = await f.configureGateway();
  try {
    const result = await new GoalOrchestrator(f.config, {
      store: f.store,
      resources: f.resources.map((resource) => ({ ...resource, endpoint: gateway.url })),
      maxInProcessWaitMs: 30_000,
    }).start("Implement the provider-neutral fixture task and verify the required artifact with the configured deterministic verifier.");
    assert.equal(result.status, "COMPLETE", `${result.reason ?? ""}\n${JSON.stringify(result.operation.units)}`);
    assert.equal(result.ledger?.requirements[0]?.status, "verified");
    const implementer = result.operation.units.find((unit) => unit.role === "implementer");
    const tester = result.operation.units.find((unit) => unit.role === "tester");
    assert.ok(implementer?.agentTaskId && tester?.agentTaskId);
    assert.equal(f.store.manager.loadTaskState(implementer.agentTaskId, f.workspace).objective?.requirements[0]?.status, "implemented");
    assert.equal(f.store.manager.loadTaskState(tester.agentTaskId, f.workspace).objective?.requirements[0]?.status, "verified");
    assertStandardContract(gateway);
  } finally { await f.cleanup(); }
});
