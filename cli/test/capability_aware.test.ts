/** PR-4: behaviour that follows the model's listed capabilities (models.dev data), never assumed when the data is absent. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { CLIENT_DEFAULT_CONTEXT, resolveLimits } from "../src/core/provider_capabilities.js";
import { acceptsToolChoice, effortLevels, snapshotModel } from "../src/core/models_snapshot.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const tools: ToolDefinition[] = [{ type: "function", function: { name: "run_command", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];
const user = (content: string): ChatMessage => ({ role: "user", content });
const textCall = { role: "assistant", content: '```json\n{"command": "echo ok"}\n```' };

/** A chat mock that always answers the call as text; returns the tool_choice of every chat request it saw. */
async function run(model: string): Promise<unknown[]> {
  const choices: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: model }] }));
      const sent = JSON.parse(body);
      choices.push(sent.tool_choice);
      if (sent.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: textCall.content }, finish_reason: null }] })}\n\n`);
        return res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end(JSON.stringify({ id: "x", model, usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ index: 0, finish_reason: "stop", message: textCall }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    await new LocalLlmClient({ provider: "openrouter", model, endpoint, apiKey: "sk-or-test-0001" } as any).chatCompletion([user("run echo ok")], tools);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  return choices;
}

test("the bundled data lists a model that takes only auto and none (the premise of the next test)", () => {
  assert.equal(acceptsToolChoice("openrouter", "anthropic/claude-fable-5.1", "auto"), true);
  assert.equal(acceptsToolChoice("openrouter", "anthropic/claude-fable-5.1", "required"), false);
  assert.equal(acceptsToolChoice("openrouter", "no-such/model", "required"), "unknown");
});

test("a model that lists no `required` gets the corrective note, never a forced tool_choice", async () => {
  const choices = await run("anthropic/claude-fable-5.1");
  assert.equal(choices.length, 2, "first request, then only the corrective-note re-ask");
  assert.equal(choices.includes("required"), false);
});

test("a model with no data keeps the forced re-ask", async () => {
  const choices = await run("no-such/model");
  assert.deepEqual(choices.at(-1), "required");
  assert.equal(choices.length, 3);
});

test("limits: advertised and operator settings outrank the model data, which outranks the client default", () => {
  const ref = { context: 200_000, output: 32_000 };
  const fromData = resolveLimits(undefined, undefined, undefined, ref);
  assert.deepEqual([fromData.contextLimit, fromData.contextSource, fromData.outputAllowance, fromData.outputSource], [200_000, "snapshot", 32_000, "snapshot"]);
  const operator = resolveLimits(undefined, 50_000, 4_000, ref);
  assert.deepEqual([operator.contextLimit, operator.contextSource, operator.outputAllowance, operator.outputSource], [50_000, "operator", 4_000, "operator"]);
  const advertised = resolveLimits({ via: "vllm", contextLength: 131_072, maxCompletionTokens: 8_000, tokenize: false }, undefined, undefined, ref);
  assert.deepEqual([advertised.contextLimit, advertised.contextSource], [131_072, "advertised"]);
  const none = resolveLimits(undefined, undefined, undefined, undefined);
  assert.deepEqual([none.contextLimit, none.contextSource], [CLIENT_DEFAULT_CONTEXT, "client_default"]);
  assert.equal(resolveLimits(undefined, undefined, undefined, { context: 0 }).contextSource, "client_default", "a zero figure is no data");
});

test("effort levels come from the data and are unknown (not unsupported) without it", () => {
  assert.deepEqual(effortLevels("openai", "gpt-5"), ["minimal", "low", "medium", "high"]);
  assert.equal(effortLevels("openai", "no-such-model"), undefined);
  assert.ok(snapshotModel("openai", "gpt-5")!.context > 0);
});

test("doctor warns about a reasoning effort the model does not list, and stays quiet without data", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runDoctor } = await import("../src/doctor.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-effort-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const base = { endpoint: "http://127.0.0.1:9/v1", maxSteps: 30, temperature: 0, workspace: home, shell: "bash" } as const;
    const check = async (over: Record<string, unknown>) => (await runDoctor({ home, timeoutMs: 1500, config: { ...base, ...over } as any })).findings.find((f) => f.id === "config.reasoning_effort")!;
    assert.equal((await check({ model: "m" })).status, "skip");
    assert.equal((await check({ provider: "openai", model: "gpt-5", reasoningEffort: "high" })).status, "pass");
    const bad = await check({ provider: "openai", model: "gpt-5", reasoningEffort: "ultra" });
    assert.equal(bad.status, "warn");
    assert.match(bad.explanation, /does not list reasoning effort "ultra"/);
    assert.equal((await check({ provider: "openai", model: "no-such-model", reasoningEffort: "ultra" })).status, "skip");
  } finally {
    process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
