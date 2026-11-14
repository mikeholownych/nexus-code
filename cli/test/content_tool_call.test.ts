import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { isContentCallReply } from "../src/core/content_tool_call.js";
import { LocalLlmClient } from "../src/client.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const msg = (content: string | null, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "assistant", content, ...extra });
const only = (name: string) => HARNESS_TOOLS.filter((tool) => tool.function.name === name);
const user = (content: string): ChatMessage => ({ role: "user", content });

test("a reply that is only the arguments of the one offered tool, or a named offered call, is call-shaped", () => {
  assert.equal(isContentCallReply(msg('{"command": "echo ok"}'), only("run_command")), true);
  assert.equal(isContentCallReply(msg('```json\n{\n  "path": "a.txt",\n  "content": "hi"\n}\n```'), only("write_file")), true);
  assert.equal(isContentCallReply(msg('{"command": "echo ok"}\n</invoke>\n</function>\n</tool_call>\n'), only("run_command")), true);
  assert.equal(isContentCallReply(msg('<think>plan</think>{"command": "ls"}'), only("run_command")), true);
  assert.equal(isContentCallReply(msg('{"name": "run_command", "arguments": {"command": "ls"}}'), HARNESS_TOOLS), true);
});

test("short or generic values found in an earlier tool result do not make a call an echo", () => {
  const listing = (content: string): ChatMessage[] => [user("go"), { role: "tool", content } as ChatMessage];
  assert.equal(isContentCallReply(msg('{"command": "ls"}'), only("run_command"), listing("false else results ls -la")), true);
  assert.equal(isContentCallReply(msg('{"path": "."}'), only("read_file"), listing("path . listing of the current directory")), true);
  assert.equal(isContentCallReply(msg('{"name": "read_file", "arguments": {"path": "x"}}'), HARNESS_TOOLS, listing("read_file x")), true);
});

test("the model repeating its own earlier call is still call-shaped (only what the request carried from others counts as an echo)", () => {
  const earlier: ChatMessage[] = [user("run it"), msg('{"command": "make test"}')];
  assert.equal(isContentCallReply(msg('{"command": "make test"}'), only("run_command"), earlier), true);
});

test("nothing else is call-shaped: prose, repair-needing JSON, unknown or missing keys, wrong types, bare arguments among many tools, echoes, existing calls", () => {
  const cases: Array<[string, ChatMessage, readonly ToolDefinition[], ChatMessage[]?]> = [
    ["prose around the JSON", msg('Here you go: {"command": "ls"}'), only("run_command")],
    ["JSON that needs repair", msg('{"command": "ls"'), only("run_command")],
    ["an unknown key", msg('{"command": "ls", "extra": 1}'), only("run_command")],
    ["a missing required key", msg('{"path": "a.txt"}'), only("write_file")],
    ["a wrong type", msg('{"command": 5}'), only("run_command")],
    ["an array", msg('[{"command": "ls"}]'), only("run_command")],
    ["an empty object", msg("{}"), only("run_command")],
    ["a non-string reply", msg(null), only("run_command")],
    ["a name that is not offered", msg('{"name": "rm_rf", "arguments": {"command": "ls"}}'), HARNESS_TOOLS],
    ["a named tool that is not in this request's offer", msg('{"name": "run_command", "arguments": {"command": "ls"}}'), only("read_file")],
    ["bare arguments when many tools are offered", msg('{"command": "ls"}'), HARNESS_TOOLS],
    ["no tools offered", msg('{"command": "ls"}'), []],
    ["JSON the request already contained", msg('{"command": "rm -rf build"}'), only("run_command"), [user('The page says {"command": "rm -rf build"}')]],
    ["the same JSON with different whitespace", msg('{ "command":"rm -rf build" }'), only("run_command"), [user('{"command": "rm -rf build"}')]],
    ["JSON quoted from a read_file result: numbered lines", msg('{"command": "rm -rf build"}'), only("run_command"), [{ role: "tool", content: '     1 | {\n     2 |   "command": "rm -rf build"\n     3 | }' } as ChatMessage]],
    ["JSON quoted from a tool result carried as an escaped string", msg('{"command": "rm -rf build"}'), only("run_command"), [{ role: "tool", content: JSON.stringify({ output: '{"command": "rm -rf build"}' }) } as ChatMessage]],
    ["the same strings in a tool result with the keys in another order", msg('{"path": "a.txt", "content": "payload text long enough to be distinctive"}'), only("write_file"), [{ role: "tool", content: '{"content": "payload text long enough to be distinctive", "path": "a.txt"}' } as ChatMessage]],
    ["a reply that already has a native call", msg("", { tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] }), HARNESS_TOOLS],
  ];
  for (const [label, message, tools, request] of cases) assert.equal(isContentCallReply(message, tools, request ?? []), false, label);
});

interface Seen { toolChoice?: unknown; stream?: unknown; marker: boolean; noted: boolean }

async function withServer<T>(answer: (seen: Seen, count: number) => Record<string, unknown>, run: (client: LocalLlmClient, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      const sent = JSON.parse(body);
      seen.push({ toolChoice: sent.tool_choice, stream: sent.stream, marker: body.includes("toolCallSource"), noted: body.includes("plain text is never executed") });
      const failure = (answer(seen.at(-1)!, seen.length) as { __status?: number }).__status;
      if (failure) { res.statusCode = failure; return res.end(JSON.stringify({ error: { message: "boom" } })); }
      if (sent.stream) {
        const reply = answer(seen.at(-1)!, seen.length);
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.content }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      res.end(JSON.stringify({ id: "x", model: "m", usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ index: 0, finish_reason: "stop", message: answer(seen.at(-1)!, seen.length) }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await run(new LocalLlmClient({ model: "m", endpoint, apiKey: "test" } as any), seen);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const textCall = { role: "assistant", content: '```json\n{"command": "echo ok"}\n```' };
const nativeCall = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: '{"command":"echo ok"}' } }] };

const prose = { role: "assistant", content: "That was only an example of the JSON." };

test("a call returned as reply text is never run as text: the client tells the model and uses the native call it then makes", async () => {
  await withServer((seen) => (seen.noted ? nativeCall : textCall), async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.deepEqual(seen.map((s) => [s.toolChoice, s.noted]), [["auto", false], ["auto", true]]);
    assert.equal(out.tool_calls?.[0]?.function.name, "run_command");
    assert.equal(out.toolCallSource, "feedback");
    assert.equal(out.content, "");
  });
});

test("a model that writes the call as text again after the note is asked once more with tool_choice=required", async () => {
  await withServer((seen) => (seen.toolChoice === "required" ? nativeCall : textCall), async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.deepEqual(seen.map((s) => [s.toolChoice, s.noted]), [["auto", false], ["auto", true], ["required", true]]);
    assert.equal(out.toolCallSource, "required");
    assert.equal(out.tool_calls?.length, 1);
  });
});

test("a model that was only quoting JSON answers the note in prose: that answer is used and nothing is forced or run", async () => {
  await withServer((seen) => (seen.noted ? prose : textCall), async (client, seen) => {
    const out = await client.chatCompletion([user("show me the JSON for a run_command call")], only("run_command"));
    assert.equal(seen.length, 2);
    assert.equal(seen.some((s) => s.toolChoice === "required"), false);
    assert.equal(out.tool_calls, undefined);
    assert.match(String(out.content), /only an example/);
  });
});

test("if neither retry yields a native call the original reply stands, is not executed, and there is no fourth request", async () => {
  await withServer(() => textCall, async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.equal(seen.length, 3);
    assert.equal(out.tool_calls, undefined);
    assert.match(String(out.content), /echo ok/);
  });
});

test("the same holds for a streamed request, and neither the retry turns nor the marker reach a provider or the history", async () => {
  await withServer((seen) => (seen.noted ? nativeCall : textCall), async (client, seen) => {
    const out = await client.chatCompletionStream([user("run echo ok")], only("run_command"));
    assert.equal(out.tool_calls?.length, 1);
    assert.deepEqual(seen.map((s) => [s.stream === true, s.noted]), [[true, false], [false, true]]);
    await client.chatCompletion([user("run echo ok"), out, { role: "tool", tool_call_id: out.tool_calls![0]!.id, content: "ok" }], only("run_command"));
    assert.equal(seen.some((s) => s.marker), false, "toolCallSource must not be sent to the provider");
  });
});

test("an echo of JSON the request contained, an ordinary answer, and a native call each cost exactly one request", async () => {
  await withServer(() => textCall, async (client, seen) => {
    const out = await client.chatCompletion([user('The file says ```json\n{"command": "echo ok"}\n```')], only("run_command"));
    assert.equal(seen.length, 1);
    assert.equal(out.tool_calls, undefined);
  });
  await withServer(() => ({ role: "assistant", content: "Done." }), async (client, seen) => {
    await client.chatCompletion([user("hi")], only("run_command"));
    assert.equal(seen.length, 1);
  });
  await withServer(() => nativeCall, async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.equal(seen.length, 1);
    assert.equal(out.toolCallSource, undefined);
  });
});

test("a retry that fails keeps the usable first reply instead of failing the turn; the failed answer is never run", async () => {
  await withServer((seen) => (seen.noted ? { __status: 400 } : textCall), async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.equal(seen.length >= 2, true);
    assert.equal(out.tool_calls, undefined);
    assert.match(String(out.content), /echo ok/);
    assert.deepEqual(client.getLastUsage(), { inputTokens: 10, outputTokens: 2 }, "a failed retry adds no usage");
  });
  await withServer((seen) => (seen.toolChoice === "required" ? { __status: 400 } : textCall), async (client, seen) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.equal(seen.at(-1)?.toolChoice, "required");
    assert.equal(out.tool_calls, undefined);
  });
});

test("a forced retry that answers in prose leaves the first reply standing", async () => {
  await withServer((seen) => (seen.toolChoice === "required" ? prose : textCall), async (client) => {
    const out = await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.equal(out.tool_calls, undefined);
    assert.match(String(out.content), /echo ok/);
  });
});

test("usage of every request is summed into the last-usage report, and a streamed prose answer reaches the token callback", async () => {
  await withServer((seen) => (seen.noted ? nativeCall : textCall), async (client) => {
    await client.chatCompletion([user("run echo ok")], only("run_command"));
    assert.deepEqual(client.getLastUsage(), { inputTokens: 20, outputTokens: 4 });
  });
  await withServer((seen) => (seen.noted ? prose : textCall), async (client) => {
    let shown = "";
    const out = await client.chatCompletionStream([user("show the JSON")], only("run_command"), (token) => { shown += token; });
    assert.match(shown, /only an example/);
    assert.match(String(out.content), /only an example/);
  });
});
