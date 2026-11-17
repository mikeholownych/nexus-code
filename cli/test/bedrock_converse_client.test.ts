import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { setOperatorProviders } from "../src/providers.js";
import { encodeFrame } from "../src/protocols/aws_eventstream.js";
import type { HarnessConfig } from "../src/types.js";

const ev = (type: string, payload: unknown) => encodeFrame({ ":event-type": type, ":message-type": "event" }, JSON.stringify(payload));

test("Bedrock Converse through the client: signed request, event-stream response, tool call", async () => {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
      res.write(Buffer.concat([
        ev("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t1", name: "ls" } } }),
        ev("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } }),
        ev("contentBlockStop", { contentBlockIndex: 0 }),
        ev("messageStop", { stopReason: "tool_use" }),
      ]));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, key: process.env.AWS_SECRET_ACCESS_KEY, region: process.env.AWS_REGION };
  process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret-test-value";
  process.env.AWS_REGION = "us-east-1";
  setOperatorProviders([{ id: "bedrock", label: "Bedrock", protocol: "bedrock-converse", auth: "sigv4", baseUrl: url, usage: "native", methods: [] }]);
  try {
    const cfg = { provider: "bedrock", endpoint: url, model: "anthropic.claude-x-v1:0", maxSteps: 4, workspace: os.tmpdir(), shell: "bash" } as HarnessConfig;
    const tools = [{ type: "function" as const, function: { name: "ls", description: "d", parameters: { type: "object", properties: {} } } }];
    const m = await new LocalLlmClient(cfg).chatCompletionStream([{ role: "user", content: "hi" }], tools);
    assert.equal(m.tool_calls![0].function.name, "ls");
    assert.equal(seen[0].path, "/model/anthropic.claude-x-v1%3A0/converse-stream");
    assert.match(String(seen[0].headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.match(String(seen[0].headers["x-amz-date"]), /^\d{8}T\d{6}Z$/);
    assert.equal(seen[0].body.toolConfig.tools[0].toolSpec.name, "ls");
    assert.ok(!JSON.stringify(seen).includes("secret-test-value"));
  } finally {
    setOperatorProviders([]);
    for (const [k, v] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.key], ["AWS_REGION", saved.region]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await new Promise<void>((r) => server.close(() => r()));
  }
});
