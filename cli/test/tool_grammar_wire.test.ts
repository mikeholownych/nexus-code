import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { generateToolCallBlockGbnf } from "../src/core/tool_grammar.js";
import { constrainTextModeToolCall, toolGrammarEnabled } from "../src/core/tool_grammar_provider.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
async function withEndpoint<T>(handler: Handler, run: (endpoint: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections?.(); server.close(); }
}
const json = (res: http.ServerResponse, body: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
const done = (res: http.ServerResponse) => json(res, { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
const msg = [{ role: "user" as const, content: "read it" }];
const readFile = HARNESS_TOOLS.find((t) => t.function.name === "read_file")!;
const customTool = { type: "function", function: { name: "custom_tool", description: "x", parameters: { type: "object", properties: { q: { type: "string" } } } } } as any;

/** A llama.cpp mock: identified by the marker plus a valid /props handshake. */
function llamaHandler(onChat: (body: any, res: http.ServerResponse) => void): Handler {
  return (req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [{ id: "m", owned_by: "llamacpp" }] });
    if (req.url === "/props") return json(res, { default_generation_settings: { n_ctx: 8192 } });
    if (req.url === "/v1/chat/completions") return onChat(JSON.parse(body), res);
    res.statusCode = 404; res.end();
  };
}
async function textModeClient(endpoint: string): Promise<LocalLlmClient> {
  const client = new LocalLlmClient({ model: "m", endpoint, apiKey: "test" } as any);
  await client.discoverAdvertisement();
  (client as any).unsupportedParams.add("tools"); // a text-mode connection: the server does not take native tools
  return client;
}
async function withEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NEXUS_TOOL_GRAMMAR;
  if (value === undefined) delete process.env.NEXUS_TOOL_GRAMMAR; else process.env.NEXUS_TOOL_GRAMMAR = value;
  try { return await run(); } finally { if (previous === undefined) delete process.env.NEXUS_TOOL_GRAMMAR; else process.env.NEXUS_TOOL_GRAMMAR = previous; }
}

/** Every rule a grammar references is defined (outside string literals and character classes). */
function undefinedRules(grammar: string): string[] {
  const defined = new Set([...grammar.matchAll(/^([A-Za-z][\w-]*) ::=/gm)].map((m) => m[1]));
  const missing = new Set<string>();
  for (const line of grammar.split("\n")) {
    const rhs = line.slice(line.indexOf("::=") + 3).replace(/"(?:\\.|[^"\\])*"/g, " ").replace(/\[(?:\\.|[^\]\\])*\]/g, " ");
    for (const m of rhs.matchAll(/[A-Za-z][\w-]*/g)) if (!defined.has(m[0])) missing.add(m[0]);
  }
  return [...missing];
}

test("the text-mode tool-call grammar is closed, lazy-compatible and admits every offered tool", () => {
  const grammar = generateToolCallBlockGbnf([readFile, customTool])!;
  assert.deepEqual(undefinedRules(grammar), []);
  assert.match(grammar, /^root ::= tool-call \(ws tool-call\)\* ws$/m);
  assert.match(grammar, /^tool-call ::= "<tool_call>"/m, "the grammar starts at the trigger, so text and <think> before it are unconstrained");
  assert.match(grammar, /\\"read_file\\"/);
  assert.match(grammar, /\\"custom_tool\\"/);
  assert.match(grammar, /^any-object ::=/m, "a non-allow-listed tool gets generic object arguments rather than being forbidden");
  assert.equal(generateToolCallBlockGbnf([]), undefined);
});

test("grammar-conforming output cannot contain explicit nulls and keeps required arguments (normaliser compatibility)", () => {
  const grammar = generateToolCallBlockGbnf([readFile])!;
  assert.doesNotMatch(grammar.split("\n").filter((l) => /^t0-member_/.test(l)).join("\n"), /null/);
  const path = readFile.function.parameters.required!;
  assert.deepEqual(path, ["path"]);
});

test("the kill switch parses off/0/false/no/disabled and defaults to on", () => {
  for (const v of ["off", "OFF", "0", "false", "no", "disabled"]) assert.equal(toolGrammarEnabled(v), false, v);
  for (const v of [undefined, "", "on", "1", "auto"]) assert.equal(toolGrammarEnabled(v), true, String(v));
});

test("a text-mode llama.cpp request carries a lazy tool-call grammar by default", async () => {
  let sent: any;
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    assert.equal(client.getDetectedServerKind(), "llamacpp");
    await client.chatCompletion(msg, [readFile, customTool]);
  }));
  assert.equal("tools" in sent, false);
  assert.equal(sent.grammar_lazy, true);
  assert.deepEqual(sent.grammar_triggers, [{ type: 1, value: "<tool_call>" }]);
  assert.match(sent.grammar, /^tool-call ::= "<tool_call>"/m);
});

test("the streaming path carries the same grammar", async () => {
  let sent: any;
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => {
    sent = b;
    res.setHeader("Content-Type", "text/event-stream");
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    await client.chatCompletionStream(msg, [readFile]);
  }));
  assert.equal(sent.stream, true);
  assert.equal(sent.grammar_lazy, true);
});

test("the kill switch removes the grammar", async () => {
  let sent: any;
  await withEnv("off", () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    await (await textModeClient(endpoint)).chatCompletion(msg, [readFile]);
  }));
  for (const key of ["grammar", "grammar_lazy", "grammar_triggers", "tools"]) assert.equal(key in sent, false, key);
});

test("native-tool llama.cpp requests never get a caller grammar (the server builds its own)", async () => {
  let sent: any;
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    const client = new LocalLlmClient({ model: "m", endpoint, apiKey: "test" } as any);
    await client.discoverAdvertisement();
    await client.chatCompletion(msg, [readFile]);
  }));
  assert.ok(sent.tools);
  assert.equal("grammar" in sent, false);
});

test("a turn with no offered tools is unconstrained", async () => {
  let sent: any;
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    await (await textModeClient(endpoint)).chatCompletion(msg, []);
  }));
  assert.equal("grammar" in sent, false);
});

test("unknown and Ollama servers are never sent a grammar or format", async () => {
  const bodies: any[] = [];
  const handler = (catalog: unknown): Handler => (req, res, body) => {
    if (req.url === "/v1/models") return json(res, { data: [catalog] });
    if (req.url === "/api/version") return json(res, { version: "0.12.3" });
    if (req.url === "/api/show") return json(res, { parameters: "num_ctx 8192" });
    if (req.url === "/v1/chat/completions") { bodies.push(JSON.parse(body)); return done(res); }
    res.statusCode = 404; res.end();
  };
  for (const [catalog, kind] of [[{ id: "m" }, "unknown"], [{ id: "m", owned_by: "library" }, "ollama"]] as const) {
    await withEnv(undefined, () => withEndpoint(handler(catalog), async (endpoint) => {
      const client = await textModeClient(endpoint);
      assert.equal(client.getDetectedServerKind(), kind);
      await client.chatCompletion(msg, [readFile]);
    }));
  }
  assert.equal(bodies.length, 2);
  for (const sent of bodies) for (const key of ["grammar", "grammar_lazy", "grammar_triggers", "format", "response_format"]) assert.equal(key in sent, false, key);
});

test("constrainTextModeToolCall fails closed for every non-llama.cpp kind and for a body that already constrains", () => {
  for (const kind of ["unknown", "vllm", "ollama", "gateway", "lmstudio"] as const) {
    const body: Record<string, unknown> = {};
    assert.equal(constrainTextModeToolCall(kind, body, [readFile], true), false, kind);
    assert.deepEqual(body, {});
  }
  assert.equal(constrainTextModeToolCall("llamacpp", { tools: [] }, [readFile], true), false);
  assert.equal(constrainTextModeToolCall("llamacpp", { grammar: "x" }, [readFile], true), false);
  assert.equal(constrainTextModeToolCall("llamacpp", { response_format: {} }, [readFile], true), false);
});

test("the grammar follows the endpoint a request is sent to on failover", async () => {
  const seen: Array<{ who: string; grammar: boolean }> = [];
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => { seen.push({ who: "llama", grammar: "grammar" in b }); res.statusCode = 503; res.end("down"); }), async (llama) =>
    withEndpoint((req, res, body) => {
      if (req.url === "/v1/chat/completions") { seen.push({ who: "plain", grammar: "grammar" in JSON.parse(body) }); return done(res); }
      res.statusCode = 404; res.end();
    }, async (plain) => {
      const client = await textModeClient(llama);
      client.addFallbackEndpoint(plain);
      await client.chatCompletion(msg, [readFile]);
    })));
  assert.deepEqual(seen.filter((s) => s.who === "llama").map((s) => s.grammar), [true]);
  assert.ok(seen.some((s) => s.who === "plain"));
  assert.ok(seen.filter((s) => s.who === "plain").every((s) => !s.grammar), "an unverified fallback is never sent a grammar");
});

test("a server that rejects the grammar is resent the request without it and stays unconstrained", async () => {
  const bodies: any[] = [];
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => {
    bodies.push(b);
    if ("grammar" in b) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "bad grammar" } })); }
    done(res);
  }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    await client.chatCompletion(msg, [readFile]);
    await client.chatCompletion(msg, [readFile]);
  }));
  assert.deepEqual(bodies.map((b) => "grammar" in b), [true, false, false]);
});

test("reasoning before the trigger is outside the grammar and the constrained call still parses (hybrid)", async () => {
  const { parseModelResponse } = await import("../src/parser.js");
  const text = '<think>I should read the file first.</think>\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
  const parsed = parseModelResponse({ role: "assistant", content: text }, { nativeTools: false });
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { path: "a.txt" });
  assert.ok(text.indexOf("<think>") < text.indexOf("<tool_call>"), "reasoning precedes the lazy trigger");
});
