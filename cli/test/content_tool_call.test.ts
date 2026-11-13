import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { recoverContentToolCall } from "../src/core/content_tool_call.js";
import type { ChatMessage } from "../src/types.js";

const msg = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content, ...extra });
const only = (name: string) => HARNESS_TOOLS.filter((tool) => tool.function.name === name);
const recovered = (message: ChatMessage) => ({ name: message.tool_calls?.[0]?.function.name, args: message.tool_calls?.[0] && JSON.parse(String(message.tool_calls[0].function.arguments)) });

test("a reply that is only a call's arguments becomes a native call for the one tool that accepts it", () => {
  const out = recoverContentToolCall(msg('{"command": "echo ok"}'), HARNESS_TOOLS);
  assert.deepEqual(recovered(out), { name: "run_command", args: { command: "echo ok" } });
  assert.equal(out.content, "");
  assert.equal(out.toolCallSource, "content");
});

test("a fenced block, leftover closing tags and a think block around the call are tolerated", () => {
  const fenced = msg('```json\n{\n  "path": "hello.txt",\n  "content": "hi"\n}\n```');
  assert.deepEqual(recovered(recoverContentToolCall(fenced, only("write_file"))), { name: "write_file", args: { path: "hello.txt", content: "hi" } });
  const tags = msg('{"command": "echo ok"}\n</invoke>\n</function>\n</tool_call>\n');
  assert.equal(recovered(recoverContentToolCall(tags, only("run_command"))).name, "run_command");
  const think = msg('<think>plan</think>{"command": "ls"}');
  assert.equal(recovered(recoverContentToolCall(think, only("run_command"))).name, "run_command");
});

test("the named form {name, arguments} recovers only an offered tool", () => {
  const ok = recoverContentToolCall(msg('{"name": "run_command", "arguments": {"command": "ls"}}'), HARNESS_TOOLS);
  assert.deepEqual(recovered(ok), { name: "run_command", args: { command: "ls" } });
  assert.equal(recoverContentToolCall(msg('{"name": "rm_rf", "arguments": {"command": "ls"}}'), HARNESS_TOOLS).tool_calls, undefined);
  assert.equal(recoverContentToolCall(msg('{"name": "run_command", "arguments": {"command": "ls"}}'), only("read_file")).tool_calls, undefined);
});

test("nothing else is recovered: prose, repaired JSON, unknown keys, missing required keys, wrong types, existing calls", () => {
  const cases: Array<[string, ChatMessage]> = [
    ["prose around the JSON", msg('Here you go: {"command": "ls"}')],
    ["JSON that needs repair", msg('{"command": "ls"')],
    ["an unknown key", msg('{"command": "ls", "extra": 1}')],
    ["a missing required key", msg('{"path": "a.txt"}')],
    ["a wrong type", msg('{"command": 5}')],
    ["an array", msg('[{"command": "ls"}]')],
    ["an empty object", msg("{}")],
    ["a non-string reply", { role: "assistant", content: null }],
  ];
  for (const [label, message] of cases) assert.equal(recoverContentToolCall(message, only("run_command")).tool_calls, undefined, label);
  const native = msg("", { tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] });
  assert.equal(recoverContentToolCall(native, HARNESS_TOOLS), native);
  assert.equal(recoverContentToolCall(msg('{"command": "ls"}'), []).tool_calls, undefined);
});

test("an arguments object that more than one offered tool accepts is left alone", () => {
  const twin = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } });
  assert.equal(recoverContentToolCall(msg('{"path": "a"}'), [twin("a"), twin("b")] as any).tool_calls, undefined);
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";

test("the client turns a server's content-form call into a native call, streaming or not, and keeps it out of the wire history", async () => {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "m" }] })); }
      const sent = JSON.parse(body);
      bodies.push(sent);
      if (sent.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"command": "echo ok"}' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '```json\n{"command": "echo ok"}\n```' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new LocalLlmClient({ model: "m", endpoint, apiKey: "test" } as any);
    const plain = await client.chatCompletion([{ role: "user", content: "run it" }], only("run_command"));
    assert.deepEqual(recovered(plain), { name: "run_command", args: { command: "echo ok" } });
    const streamed = await client.chatCompletionStream([{ role: "user", content: "run it" }], only("run_command"));
    assert.deepEqual(recovered(streamed), { name: "run_command", args: { command: "echo ok" } });
    await client.chatCompletion([{ role: "user", content: "run it" }, plain, { role: "tool", tool_call_id: plain.tool_calls![0]!.id, content: "ok" }], only("run_command"));
    assert.equal(JSON.stringify(bodies.at(-1)).includes("toolCallSource"), false, "the recovery marker must not reach a provider");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
