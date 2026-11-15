import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, chatStreamParser, chatUsage, parseChatResponse } from "../src/protocols/openai_chat.js";
import { WIRE_PROTOCOLS } from "../src/protocols/index.js";

const base = { model: "m", messages: [{ role: "user" as const, content: "hi" }], tools: [], temperature: 0.2, maxOutputTokens: 100, owner: "x:m" };

test("request: path, key order and optional params follow the stream flag and options", () => {
  const plain = buildChatRequest({ ...base, stream: false, chat: { toolChoice: "auto", capOutput: true, usage: "none" } });
  assert.equal(plain.path, "/chat/completions");
  assert.deepEqual(Object.keys(plain.body), ["model", "messages", "temperature", "max_tokens"]);
  const streamed = buildChatRequest({ ...base, stream: true, chat: { toolChoice: "auto", capOutput: false, usage: "openrouter" } });
  assert.deepEqual(Object.keys(streamed.body), ["model", "messages", "temperature", "stream", "usage", "stream_options"]);
});

test("usage keeps only finite numbers", () => {
  assert.deepEqual(chatUsage({ prompt_tokens: 1, completion_tokens: "x", cost: 2 }), { inputTokens: 1, costUsd: 2 });
  assert.equal(chatUsage(null), undefined);
});

test("parse: finish mapping and object arguments", () => {
  const r = parseChatResponse({ id: "i", model: "e", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "n", arguments: { a: 1 } } }] } }] });
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.message.tool_calls![0].function.arguments, '{"a":1}');
  assert.equal(parseChatResponse({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "c" } }] }).finish, "length");
});

test("stream parser: no finish_reason and no [DONE] is incomplete; fragments without index split on id/name", () => {
  const p = chatStreamParser();
  p.line('data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"x","arguments":"{"}}]}}]}');
  p.line('data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]}}]}');
  p.line('data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"y"}}]}}]}');
  assert.equal(p.result().finish, "incomplete");
  p.line("data: [DONE]");
  const r = p.result();
  assert.equal(r.finish, "tool_calls");
  assert.deepEqual(r.message.tool_calls!.map((c) => [c.id, c.function.name, c.function.arguments]), [["a", "x", "{}"], ["b", "y", ""]]);
});

test("registry: chat is the client's own pipeline, the other protocols share the native path", () => {
  assert.deepEqual(Object.entries(WIRE_PROTOCOLS).map(([k, v]) => [k, v.native]), [["openai-chat", false], ["openai-responses", true], ["anthropic-messages", true]]);
});
