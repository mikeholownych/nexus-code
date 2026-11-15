/**
 * Characterization of the openai-chat wire behaviour of LocalLlmClient: pinned before and after the protocol was
 * moved to src/protocols/openai_chat.ts, so both must pass unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

type Handler = (body: any, res: http.ServerResponse, count: number) => void;

async function withServer<T>(handler: Handler, run: (client: LocalLlmClient, bodies: any[], raw: string[]) => Promise<T>): Promise<T> {
  const bodies: any[] = [];
  const raw: string[] = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "m" }] })); }
      raw.push(text);
      bodies.push(JSON.parse(text));
      handler(bodies.at(-1), res, bodies.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    return await run(new LocalLlmClient({ model: "m", endpoint, apiKey: "k", workspace: "/tmp", maxSteps: 1 } as any), bodies, raw);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const user: ChatMessage[] = [{ role: "user", content: "hi" }];
const tool = (name: string): ToolDefinition => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }) as any;
const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const sse = (res: http.ServerResponse, ...frames: string[]) => { res.setHeader("Content-Type", "text/event-stream"); res.write(frames.join("")); res.end(); };
const json = (res: http.ServerResponse, status: number, o: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
const delta = (d: unknown, finish: string | null = null) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

test("stream fragments without an index: an id or name starts a new call, a bare fragment continues the latest", async () => {
  await withServer((_b, res) => sse(res,
    delta({ tool_calls: [{ id: "a", function: { name: "alpha", arguments: '{"x":' } }] }),
    delta({ tool_calls: [{ function: { arguments: "1}" } }] }),
    delta({ tool_calls: [{ id: "b", function: { name: "beta", arguments: "{}" } }] }),
    delta({}, "tool_calls"), "data: [DONE]\n\n",
  ), async (client) => {
    const m = await client.chatCompletionStream(user, [tool("alpha"), tool("beta")]);
    assert.deepEqual(m.tool_calls?.map((c) => [c.id, c.function.name, c.function.arguments]), [["a", "alpha", '{"x":1}'], ["b", "beta", "{}"]]);
    assert.equal(m.content, null);
  });
});

test("stream reasoning: reasoning_content wins over reasoning; reasoning alone is kept; a reasoning-only stream is not empty", async () => {
  await withServer((_b, res, n) => n === 1
    ? sse(res, delta({ reasoning_content: "R1", reasoning: "ignored" }), delta({ reasoning: "R2" }), delta({ content: "ans" }, "stop"))
    : sse(res, delta({ reasoning: "only" }, "stop")),
  async (client, bodies) => {
    const a = await client.chatCompletionStream(user, []);
    assert.equal(a.reasoning_content, "R1R2");
    assert.equal(a.content, "ans");
    const b = await client.chatCompletionStream(user, []);
    assert.equal(b.reasoning_content, "only");
    assert.equal(b.content, null);
    assert.equal(bodies.length, 2, "no empty-stream re-request");
  });
});

test("an empty stream is re-requested once without streaming under a new request id", async () => {
  await withServer((_b, res, n) => n === 1 ? sse(res, delta({}, "stop")) : json(res, 200, { id: "i", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "late" } }] }),
  async (client, bodies) => {
    const m = await client.chatCompletionStream(user, []);
    assert.equal(m.content, "late");
    assert.deepEqual(bodies.map((b) => b.stream), [true, undefined]);
  });
});

test("a rejected stream_options is dropped and the request retried once", async () => {
  await withServer((b, res) => b.stream_options
    ? json(res, 400, { error: { message: "Unsupported parameter: stream_options" } })
    : sse(res, delta({ content: "ok" }, "stop")),
  async (client, bodies) => {
    const m = await client.chatCompletionStream(user, []);
    assert.equal(m.content, "ok");
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.equal("stream_options" in bodies[1], false);
    assert.equal(bodies[1].model, "m");
  });
});

test("request bodies: key order and tool_choice for streamed and non-streamed requests", async () => {
  await withServer((b, res) => b.stream
    ? sse(res, delta({ content: "s" }, "stop"))
    : json(res, 200, { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "n" } }] }),
  async (client, _b, raw) => {
    await client.chatCompletionStream(user, [tool("alpha")]);
    await client.chatCompletion(user, [tool("alpha")]);
    assert.deepEqual(Object.keys(JSON.parse(raw[0])), ["model", "messages", "temperature", "stream", "tools", "tool_choice", "max_tokens", "stream_options"]);
    assert.deepEqual(Object.keys(JSON.parse(raw[1])), ["model", "messages", "temperature", "max_tokens", "tools", "tool_choice"]);
  });
});

test("usage is parsed from a streamed final chunk and from a non-streamed body", async () => {
  await withServer((b, res) => b.stream
    ? sse(res, delta({ content: "a" }, "stop"), chunk({ id: "g1", model: "eff", choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.5 } }), "data: [DONE]\n\n")
    : json(res, 200, { id: "g2", usage: { prompt_tokens: 11, completion_tokens: 13 }, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "b" } }] }),
  async (client) => {
    await client.chatCompletionStream(user, []);
    assert.deepEqual(client.getLastUsage(), { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, reasoningTokens: 3, costUsd: 0.5 });
    await client.chatCompletion(user, []);
    assert.deepEqual(client.getLastUsage(), { inputTokens: 11, outputTokens: 13 });
  });
});

test("a stream with neither finish_reason nor [DONE] is incomplete; [DONE] alone completes it", async () => {
  await withServer((_b, res, n) => n === 1 ? sse(res, delta({ content: "part" })) : sse(res, delta({ content: "whole" }), "data: [DONE]\n\n"),
  async (client) => {
    await assert.rejects(client.chatCompletionStream(user, []), (e: any) => e.kind === "stream_incomplete" && e.partialText === "part");
    assert.equal((await client.chatCompletionStream(user, [])).content, "whole");
  });
});

test("a mid-stream error frame is a provider_error_frame carrying the text so far", async () => {
  await withServer((_b, res) => sse(res, delta({ content: "some" }), chunk({ error: { message: "backend exploded", type: "server_error" } })),
  async (client) => {
    await assert.rejects(client.chatCompletionStream(user, []), (e: any) => e.kind === "provider_error_frame" && /backend exploded/.test(e.message) && e.partialText === "some");
  });
});

test("a malformed stream event is malformed_event", async () => {
  await withServer((_b, res) => sse(res, delta({ content: "x" }), "data: {not json\n\n"),
  async (client) => {
    await assert.rejects(client.chatCompletionStream(user, []), (e: any) => e.kind === "malformed_event" && e.message.startsWith("Malformed stream event: data: {not json"));
  });
});

test("finish_reason=length refuses partial output, streamed and not, and names the cut-off calls", async () => {
  await withServer((b, res) => b.stream
    ? sse(res, delta({ tool_calls: [{ index: 0, id: "c", function: { name: "alpha", arguments: '{"a"' } }] }, "length"))
    : json(res, 200, { choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "cut" } }] }),
  async (client) => {
    await assert.rejects(client.chatCompletionStream(user, [tool("alpha")]), (e: any) => e.kind === "output_truncated" && /inside a tool call/.test(e.message) && e.truncatedCalls?.length === 1);
    await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "output_truncated" && /finish_reason=length/.test(e.message) && e.partialText === "cut");
  });
});

test("non-streamed: an empty choices array is a protocol_error and object arguments are serialized", async () => {
  await withServer((_b, res, n) => n === 1
    ? json(res, 200, { choices: [] })
    : json(res, 200, { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "alpha", arguments: { q: 1 } } }] } }] }),
  async (client) => {
    await assert.rejects(client.chatCompletion(user, []), (e: any) => e.kind === "protocol_error");
    const m = await client.chatCompletion(user, [tool("alpha")]);
    assert.equal(m.tool_calls?.[0]?.function.arguments, '{"q":1}');
  });
});
