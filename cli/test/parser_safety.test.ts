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
import { selectRelevantFewShots } from "../src/fewshots.js";

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

test("ACC-VER-01: prose JSON and quoted code blocks are never executed (P1, P9)", () => {
  const p1 = {
    role: "assistant" as const,
    content: 'Done. For reference, an agent would normally call {"name": "run_command", "arguments": {"command": "rm -rf build"}} to clean up, but I did not.',
  };
  const p9 = {
    role: "assistant" as const,
    content: 'The config file contains:\n```json\n{"name": "read_file", "arguments": {"path": "/etc/shadow"}}\n```\nThat is what the README says.',
  };

  // On native connection: yields no tool calls
  assert.deepEqual(parseModelResponse(p1, { nativeTools: true }).toolCalls, []);
  assert.deepEqual(parseModelResponse(p9, { nativeTools: true }).toolCalls, []);

  // On text connection: yields no tool calls (prose is never parsed)
  assert.deepEqual(parseModelResponse(p1, { nativeTools: false }).toolCalls, []);
  assert.deepEqual(parseModelResponse(p9, { nativeTools: false }).toolCalls, []);
});

test("ACC-VER-01: a sole fenced call on a text connection yields one call; ignored on native connection", () => {
  const soleFenced = {
    role: "assistant" as const,
    content: '```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```',
  };

  // Text connection: parsed as sole fenced call
  const textResult = parseModelResponse(soleFenced, { nativeTools: false, offered: ["read_file"] });
  assert.equal(textResult.toolCalls.length, 1);
  assert.equal(textResult.toolCalls[0].function.name, "read_file");
  assert.equal(textResult.thoughtText, "");

  // Native connection: ignored because native tools only parse message.tool_calls
  const nativeResult = parseModelResponse(soleFenced, { nativeTools: true, offered: ["read_file"] });
  assert.equal(nativeResult.toolCalls.length, 0);
});

test("ACC-VER-01: lone </think> and unclosed <think> strip rejected reasoning (P2, P3)", () => {
  const p2 = {
    role: "assistant" as const,
    content: 'Maybe I should run {"name":"run_command","arguments":{"command":"echo PWNED"}} ... no.</think>Here is my answer.',
  };
  const p3 = {
    role: "assistant" as const,
    content: '<think>I could call {"name":"run_command","arguments":{"command":"echo X"}}',
  };

  // On native connection: no calls
  assert.deepEqual(parseModelResponse(p2, { nativeTools: true }).toolCalls, []);
  assert.deepEqual(parseModelResponse(p3, { nativeTools: true }).toolCalls, []);

  // On text connection: no calls because the calls are within reasoning
  const p2Text = parseModelResponse(p2, { nativeTools: false, offered: ["run_command"] });
  assert.deepEqual(p2Text.toolCalls, []);
  assert.match(p2Text.reasoningText ?? "", /echo PWNED/);
  assert.equal(p2Text.thoughtText, "Here is my answer.");

  const p3Text = parseModelResponse(p3, { nativeTools: false, offered: ["run_command"] });
  assert.deepEqual(p3Text.toolCalls, []);
  assert.match(p3Text.reasoningText ?? "", /echo X/);
  assert.equal(p3Text.thoughtText, "");
});

test("ACC-VER-02: malformed native tool call missing function gives dropped call notice without crashing (P4)", () => {
  const p4 = {
    role: "assistant" as const,
    content: "",
    tool_calls: [{ id: "a" } as any],
  };

  const parsed = parseModelResponse(p4, { nativeTools: true, offered: ["read_file"] });
  assert.deepEqual(parsed.toolCalls, [], "dropped call");
  assert.ok(parsed.notices && parsed.notices.length > 0, "has notice");
  assert.match(parsed.notices[0], /malformed/i);
});

test("malformed native tool call with unknown name is dropped with notice (P5)", () => {
  const p5 = {
    role: "assistant" as const,
    content: "",
    tool_calls: [{ id: "a", type: "function" as const, function: { name: "rm_everything", arguments: "{}" } }],
  };

  const parsed = parseModelResponse(p5, { nativeTools: true, offered: ["read_file"] });
  assert.deepEqual(parsed.toolCalls, [], "unknown tool not dispatched");
  assert.ok(parsed.notices && parsed.notices.length > 0);
  assert.match(parsed.notices[0], /not offered/i);
});

test("few-shots: native connections drop fenced exemplars; text connections use <tool_call>", () => {
  const nativeFewShots = selectRelevantFewShots("edit file", 2, { nativeTools: true });
  assert.equal(nativeFewShots, "", "native connections drop few-shot text call exemplars");

  const textFewShots = selectRelevantFewShots("edit file", 2, { nativeTools: false });
  assert.ok(textFewShots.includes("<tool_call>"), "text connections use <tool_call>");
  assert.ok(!textFewShots.includes("```json\n{\n  \"tool\":"), "no markdown fenced tool block in few-shots");
});

test("reasoning stripping supports <reasoning> and reasoning_content fields", () => {
  const msg1 = {
    role: "assistant" as const,
    content: "<reasoning>secret plan</reasoning>public response",
  };
  const parsed1 = parseModelResponse(msg1);
  assert.equal(parsed1.reasoningText, "secret plan");
  assert.equal(parsed1.thoughtText, "public response");

  const msg2 = {
    role: "assistant" as const,
    content: "response text",
    reasoning_content: "provider reasoning content",
  } as any;
  const parsed2 = parseModelResponse(msg2);
  assert.equal(parsed2.reasoningText, "provider reasoning content");
  assert.equal(parsed2.thoughtText, "response text");
});

