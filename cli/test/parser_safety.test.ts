/**
 * Tool calls come only from the reply, never from reasoning, and only for tools that exist on the request; streamed
 * events are read whether or not the `data:` field has a space after its colon.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { parseModelResponse, repairJson } from "../src/parser.js";
import { LocalLlmClient } from "../src/client.js";

test("a tool call written inside <think> reasoning is never extracted", () => {
  const parsed = parseModelResponse({
    role: "assistant",
    content: '<think>Maybe I should run {"tool": "run_command", "arguments": {"command": "rm -rf build"}}</think>I will read the file first.',
  });
  assert.deepEqual(parsed.toolCalls, []);
  assert.match(parsed.reasoningText ?? "", /rm -rf build/);
  assert.equal(parsed.thoughtText, "I will read the file first.");
});

test("text tool calls are accepted only for offered tools (plugin tools included), unknown names are not calls", () => {
  const content = '```json\n{"tool": "lint_project", "arguments": {"fix": false}}\n```';
  assert.deepEqual(parseModelResponse({ role: "assistant", content }).toolCalls, [], "an unknown name is text");
  const offered = parseModelResponse({ role: "assistant", content }, ["read_file", "lint_project"]);
  assert.equal(offered.toolCalls.length, 1);
  assert.equal(offered.toolCalls[0].function.name, "lint_project");
  const builtin = parseModelResponse({ role: "assistant", content: '<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>' });
  assert.equal(builtin.toolCalls[0]?.function.name, "read_file");
  assert.deepEqual(parseModelResponse({ role: "assistant", content: '<tool_call>{"name": "read_file", "arguments": {}}</tool_call>' }, ["write_file"]).toolCalls, [], "not offered on this request");
});

test("JSON repair keeps string contents intact", () => {
  const repaired = repairJson(`{"content": "True: None, {not: json}, a,]", "ok": True, "lines": "one
two",}`);
  assert.equal(repaired.content, "True: None, {not: json}, a,]", "literals and brackets inside a string are not rewritten");
  assert.equal(repaired.ok, true, "a Python literal outside strings is");
  assert.equal(repaired.lines, "one\ntwo", "a raw newline inside a string is kept as a newline");
});

test("stream events are read with or without a space after `data:`", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data:${JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] })}\n\n`);
    res.end("data:[DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    const client = new LocalLlmClient({ model: "m", endpoint: `http://127.0.0.1:${port}/v1`, apiKey: "k" } as any);
    const tokens: string[] = [];
    const message = await client.chatCompletionStream([{ role: "user", content: "hi" }], [], (t: string) => tokens.push(t));
    assert.equal(message.content, "Hello world");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
