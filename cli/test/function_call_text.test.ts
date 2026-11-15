import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/leak_guard.js";
import { HARNESS_TOOLS } from "../src/core/capabilities.js";
import { isContentCallReply } from "../src/core/content_tool_call.js";
import { LocalLlmClient } from "../src/client.js";
import { startGateway } from "./helpers/fixtures.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const msg = (content: string | null): ChatMessage => ({ role: "assistant", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const tool = (name: string): ToolDefinition => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });
const offered: ToolDefinition[] = [tool("read_file"), tool("write_file"), tool("run_command")];

test("a reply that is only function-call text to an offered tool is a call written as text", () => {
  const positive = [
    'read_file(path="README.md")',
    '  read_file(path="README.md")\n',
    '```\nread_file(path="README.md")\n```',
    '```python\nread_file(path="README.md")\n```',
    '[read_file(path="README.md")]',
    '```python\n[read_file(path="README.md")]\n```',
    "read_file(path='README.md')",
    'write_file(path="a.txt", content="line1\\nsay \\"hi\\" and it\'s fine")',
    "write_file(path='a.txt', content='it\\'s')",
    'run_command(command="ls", env={"A": "1", "B": [1, 2.5, -3e2]}, items=[["x"], {"k": None}])',
    'run_command(command="ls", background=True, retry=False, extra=None, more=true, n=null)',
    '[read_file(path="a"), write_file(path="b", content="c")]',
    '[read_file(path="a"),\n write_file(path="b", content="c"),]',
    'read_file(path="README.md",)',
    'read_file()',
    '<think>plan</think>read_file(path="README.md")',
    'run_command(command="echo (not a close)")',
  ];
  for (const text of positive) assert.equal(isContentCallReply(msg(text), offered), true, text);
});

test("prose, other calls, and anything but literal keyword arguments are not call-shaped", () => {
  const negative: Array<[string, string]> = [
    ["a sentence mentioning the call", 'I will call read_file(path="README.md") now.'],
    ["a call followed by an explanation", 'read_file(path="README.md")\nThis reads the file.'],
    ["an explanation then the call", 'Sure:\nread_file(path="README.md")'],
    ["a fenced call with text around it", 'Here:\n```python\nread_file(path="README.md")\n```\nDone.'],
    ["two fences", '```\nread_file(path="a")\n``` ```\nread_file(path="b")\n```'],
    ["an unknown tool", 'delete_everything(path="README.md")'],
    ["one unknown tool in a list", '[read_file(path="a"), nope(x=1)]'],
    ["an unbalanced parenthesis", 'read_file(path="README.md"'],
    ["an unbalanced list", '[read_file(path="README.md")'],
    ["an unterminated string", 'read_file(path="README.md)'],
    ["a variable argument", "read_file(path=README)"],
    ["a variable inside a list", "run_command(command=[a, b])"],
    ["an expression argument", 'read_file(path="a" + "b")'],
    ["a call argument", 'read_file(path=open("a"))'],
    ["a positional argument", 'read_file("README.md")'],
    ["a duplicated keyword", 'read_file(path="a", path="b")'],
    ["a dict with a non-literal key", "run_command(command=\"x\", env={a: 1})"],
    ["a tuple", 'run_command(command="x", env=(1, 2))'],
    ["an f-string", 'read_file(path=f"a")'],
    ["a method call", 'os.read_file(path="a")'],
    ["trailing code", 'read_file(path="a"); rm_rf()'],
    ["two calls without a list", 'read_file(path="a")\nread_file(path="b")'],
    ["a bare name", "read_file"],
    ["an empty list", "[]"],
    ["an unknown escape", 'read_file(path="a\\qb")'],
    ["JSON-style call array", '[{"name": "read_file", "arguments": {"path": "a"}}]'],
    ["a number that is not one", "read_file(path=1.2.3)"],
    ["a string with a raw newline", 'read_file(path="a\nb")'],
  ];
  for (const [why, text] of negative) assert.equal(isContentCallReply(msg(text), offered), false, why);
});

test("nesting is bounded and an existing native call or an empty tool list is never call-shaped", () => {
  assert.equal(isContentCallReply(msg(`run_command(command=${"[".repeat(40)}${"]".repeat(40)})`), offered), false);
  assert.equal(isContentCallReply(msg('read_file(path="a")'), []), false);
  const native: ChatMessage = { role: "assistant", content: 'read_file(path="a")', tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] };
  assert.equal(isContentCallReply(native, offered), false);
});

test("a call the request already held (the model quoting what it read) is not a request for a call", () => {
  const history: ChatMessage[] = [user("what does the doc say?"), { role: "tool", content: 'Use read_file(path="README.md") to read it.' } as ChatMessage];
  assert.equal(isContentCallReply(msg('read_file(path="README.md")'), offered, history), false);
  assert.equal(isContentCallReply(msg('read_file(path="README.md")'), offered, [user("read the readme")]), true);
});

test("the client asks again when the reply was function-call text, and uses only the native call that comes back", async () => {
  const gw = await startGateway((n) => (n === 1
    ? { kind: "text", content: 'read_file(path="README.md")' }
    : { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }] }));
  try {
    const client = new LocalLlmClient({ model: "m", endpoint: gw.url, apiKey: "test" } as any);
    const out = await client.chatCompletion([user("read the readme")], HARNESS_TOOLS.filter((t) => t.function.name === "read_file"));
    const requests = gw.requests as any[];
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tool_choice, "auto");
    assert.ok(requests[1].messages.some((m: any) => m.role === "user" && /plain text is never executed/.test(String(m.content))));
    assert.equal(out.toolCallSource, "feedback");
    assert.equal(out.tool_calls?.[0]?.function.name, "read_file");
    assert.deepEqual(JSON.parse(out.tool_calls![0]!.function.arguments), { path: "README.md" });
  } finally {
    await gw.close();
  }
});

test("a model that keeps writing the function call as text is forced with tool_choice=required, and the text is never run", async () => {
  const gw = await startGateway((n, body) => (body?.tool_choice === "required"
    ? { kind: "tools", calls: [{ name: "read_file", args: { path: "README.md" } }] }
    : { kind: "text", content: '[read_file(path="README.md")]' }));
  try {
    const client = new LocalLlmClient({ model: "m", endpoint: gw.url, apiKey: "test" } as any);
    const out = await client.chatCompletion([user("read the readme")], HARNESS_TOOLS.filter((t) => t.function.name === "read_file"));
    assert.deepEqual((gw.requests as any[]).map((r) => r.tool_choice), ["auto", "auto", "required"]);
    assert.equal(out.toolCallSource, "required");
  } finally {
    await gw.close();
  }
});

test("prose that mentions a call is answered as prose: one request, no retry", async () => {
  const gw = await startGateway(() => ({ kind: "text", content: 'You can use read_file(path="README.md") to read it.' }));
  try {
    const client = new LocalLlmClient({ model: "m", endpoint: gw.url, apiKey: "test" } as any);
    const out = await client.chatCompletion([user("how do I read it?")], HARNESS_TOOLS.filter((t) => t.function.name === "read_file"));
    assert.equal((gw.requests as any[]).length, 1);
    assert.equal(out.tool_calls, undefined);
  } finally {
    await gw.close();
  }
});
