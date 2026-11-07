import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalLlmClient } from "../src/client.js";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { generateToolArgumentsGbnf, generateToolCallBlockGbnf } from "../src/core/tool_grammar.js";
import { constrainTextModeToolCall, isGrammarRejection, toolGrammarDefault, toolGrammarEnabled } from "../src/core/tool_grammar_provider.js";

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

test("the text-mode tool-call grammar is closed and admits every offered tool", () => {
  const grammar = generateToolCallBlockGbnf([readFile, customTool])!;
  assert.deepEqual(undefinedRules(grammar), []);
  assert.match(grammar, /^root ::= text-0$/m, "the whole reply is described, starting with free text");
  assert.match(grammar, /\\"read_file\\"/);
  assert.match(grammar, /\\"custom_tool\\"/);
  assert.match(grammar, /^any-object ::=/m, "a non-allow-listed tool gets generic object arguments rather than being forbidden");
  assert.equal(generateToolCallBlockGbnf([]), undefined);
});

test("grammar-conforming output cannot contain explicit nulls and keeps required arguments (normaliser compatibility)", () => {
  const grammar = generateToolCallBlockGbnf([readFile])!;
  assert.doesNotMatch(grammar.split("\n").filter((l) => /^t0-member-/.test(l)).join("\n"), /null/);
  const path = readFile.function.parameters.required!;
  assert.deepEqual(path, ["path"]);
});

test("NEXUS_TOOL_GRAMMAR parses on/off and otherwise follows the single default, which ships OFF", () => {
  assert.equal(toolGrammarDefault, false, "flip this constant to turn the feature on by default after the live llama.cpp smoke test");
  for (const v of ["off", "OFF", "0", "false", "no", "disabled"]) assert.equal(toolGrammarEnabled(v), false, v);
  for (const v of ["on", "ON", "1", "true", "yes", "enabled"]) assert.equal(toolGrammarEnabled(v), true, v);
  for (const v of [undefined, "", "auto"]) assert.equal(toolGrammarEnabled(v), toolGrammarDefault, String(v));
  for (const v of [undefined, "", "auto"]) assert.equal(toolGrammarEnabled(v, true), true, "the default is the one knob");
});

test("a text-mode llama.cpp request carries the tool-call grammar when enabled", async () => {
  let sent: any;
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    assert.equal(client.getDetectedServerKind(), "llamacpp");
    await client.chatCompletion(msg, [readFile, customTool]);
  }));
  assert.equal("tools" in sent, false);
  assert.match(sent.grammar, /^root ::= text-0$/m);
  for (const key of ["grammar_lazy", "grammar_triggers"]) assert.equal(key in sent, false, `${key} is discarded by llama-server's chat endpoint, so it is not relied on`);
});

test("the streaming path carries the same grammar", async () => {
  let sent: any;
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => {
    sent = b;
    res.setHeader("Content-Type", "text/event-stream");
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    await client.chatCompletionStream(msg, [readFile]);
  }));
  assert.equal(sent.stream, true);
  assert.match(sent.grammar, /^root ::= text-0$/m);
});

test("by default (flag unset) no grammar is sent", async () => {
  let sent: any;
  await withEnv(undefined, () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    await (await textModeClient(endpoint)).chatCompletion(msg, [readFile]);
  }));
  assert.equal("grammar" in sent, false);
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
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    const client = new LocalLlmClient({ model: "m", endpoint, apiKey: "test" } as any);
    await client.discoverAdvertisement();
    await client.chatCompletion(msg, [readFile]);
  }));
  assert.ok(sent.tools);
  assert.equal("grammar" in sent, false);
});

test("a turn with no offered tools is unconstrained", async () => {
  let sent: any;
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
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
    await withEnv("on", () => withEndpoint(handler(catalog), async (endpoint) => {
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
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => { seen.push({ who: "llama", grammar: "grammar" in b }); res.statusCode = 503; res.end("down"); }), async (llama) =>
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

test("a server that rejects the grammar is resent the request without it; only that endpoint, only for a while", async () => {
  const bodies: any[] = [];
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    await withEnv("on", () => withEndpoint(llamaHandler((b, res) => {
      bodies.push(b);
      if ("grammar" in b) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "failed to parse grammar" } })); }
      done(res);
    }), async (endpoint) => {
      const client = await textModeClient(endpoint);
      await client.chatCompletion(msg, [readFile]);
      await client.chatCompletion(msg, [readFile]);
      offset = 11 * 60_000;
      await client.chatCompletion(msg, [readFile]);
    }));
  } finally { Date.now = realNow; }
  assert.deepEqual(bodies.map((b) => "grammar" in b), [true, false, false, true, false], "rejected once, unconstrained for the TTL, retried after it");
});

test("an unrelated 400 (context overflow) does not disable the grammar", async () => {
  let n = 0;
  const grammars: boolean[] = [];
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => {
    grammars.push("grammar" in b);
    if (++n === 1) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "the request exceeds the available context size" } })); }
    done(res);
  }), async (endpoint) => {
    const client = await textModeClient(endpoint);
    await client.chatCompletion(msg, [readFile]).catch(() => undefined);
    await client.chatCompletion(msg, [readFile]);
  }));
  assert.deepEqual(grammars, [true, true]);
  assert.equal(isGrammarRejection("the request exceeds the available context size"), false);
  assert.equal(isGrammarRejection("Failed to parse grammar"), true);
});

test("the kind lookup uses the credential-scoped key, not the raw endpoint", async () => {
  let sent: any;
  await withEnv("on", () => withEndpoint(llamaHandler((b, res) => { sent = b; done(res); }), async (endpoint) => {
    const client = new LocalLlmClient({ model: "m", endpoint, apiKey: "scoped-credential" } as any);
    client.setApiKey("scoped-credential");
    await client.discoverAdvertisement();
    (client as any).unsupportedParams.add("tools");
    await client.chatCompletion(msg, [readFile]);
  }));
  assert.ok(sent.grammar, "a lookup by the raw endpoint would miss the identity cached under the credential-scoped key");
});

test("reasoning then a call parses with the unchanged text-mode parser", async () => {
  const { parseModelResponse } = await import("../src/parser.js");
  const text = '<think>I should read the file first.</think>\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
  const parsed = parseModelResponse({ role: "assistant", content: text }, { nativeTools: false });
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { path: "a.txt" });
});

test("the grammar is correct even when a server applies it eagerly: free text, <think> and tool calls all parse (structural proof)", async () => {
  const { gbnfAccepts } = await import("./helpers/gbnf_match.js");
  const grammar = generateToolCallBlockGbnf([readFile, customTool])!;
  const call = (name: string, args: unknown) => `<tool_call>{"name":"${name}","arguments":${JSON.stringify(args)}}</tool_call>`;
  const accepted = [
    "",
    "Here is the answer.",
    "I used a < b and <html> markup and <tool but not the tag.",
    "<think>The user wants a file.\nI will read it.</think>\nDone, nothing to run.",
    call("read_file", { path: "a.txt" }),
    call("read_file", { path: "a.txt", start_line: 3 }),
    call("custom_tool", { q: "x", extra: [1, { a: null }] }),
    `<think>plan</think>\n${call("read_file", { path: "a.txt" })}`,
    `${call("read_file", { path: "a.txt" })}\n${call("read_file", { path: "b.txt" })}`,
    `<think>mentions ${call("read_file", { path: "x" })} then continues</think> final text`,
    `${call("read_file", { path: "a.txt" })} trailing words`,
  ];
  for (const text of accepted) assert.equal(gbnfAccepts(grammar, text), true, JSON.stringify(text));
  const rejected = [
    '<tool_call>{"name":"read_file","arguments":{}}</tool_call>', // required argument missing
    '<tool_call>{"name":"read_file","arguments":{"path":null}}</tool_call>',
    '<tool_call>{"name":"nope","arguments":{}}</tool_call>',
    "<tool_call>not json</tool_call>",
  ];
  for (const text of rejected) assert.equal(gbnfAccepts(grammar, text), false, JSON.stringify(text));
});

test("every rule name is valid GBNF (lowercase letters, digits and dashes)", () => {
  const grammar = generateToolCallBlockGbnf([readFile, customTool])!;
  const names = [...grammar.matchAll(/^(\S+) ::=/gm)].map((m) => m[1]);
  assert.ok(names.length > 10);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9-]*$/, name);
  for (const name of [...generateToolArgumentsGbnf("read_file").matchAll(/^(\S+) ::=/gm)].map((m) => m[1])) assert.match(name, /^[a-z][a-z0-9-]*$/, name);
});
