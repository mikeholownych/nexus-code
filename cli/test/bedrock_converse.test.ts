import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signingKey, signSigV4, uriEncode } from "../src/protocols/aws_sigv4.js";
import { crc32, encodeFrame, EventStreamDecoder, readEventStream } from "../src/protocols/aws_eventstream.js";
import { parseIni, resolveAwsCredentials, resolveAwsRegion } from "../src/protocols/aws_credentials.js";
import { buildBedrockRequest, parseBedrockResponse, bedrockStreamParser, signBedrockRequest } from "../src/protocols/bedrock_converse.js";
import { stateDigest } from "../src/protocols/common.js";
import { wireProtocol } from "../src/protocols/index.js";

const EXAMPLE = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

// AWS Signature Version 4 test suite, "get-vanilla" (GET / on example.amazonaws.com, 20150830T123600Z, us-east-1,
// service "service"), as published with the SigV4 documentation:
// https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
test("SigV4 get-vanilla test vector", () => {
  const r = signSigV4({ method: "GET", url: "https://example.amazonaws.com/", body: "", region: "us-east-1", service: "service", credentials: EXAMPLE, now: new Date("2015-08-30T12:36:00Z") });
  assert.equal(r.canonicalRequest, "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(r.stringToSign, "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  assert.equal(r.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(r.headers.Authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

// "Examples of how to derive a signing key" in the IAM User Guide (service iam, us-east-1, 20150830):
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
test("SigV4 signing key derivation vector", () => {
  assert.equal(signingKey(EXAMPLE.secretAccessKey, "20150830", "us-east-1", "iam").toString("hex"), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

test("SigV4: query sorted and encoded, path segments double-encoded, session token signed", () => {
  const r = signSigV4({ method: "POST", url: "https://h.example.com/model/a.b%3A0/converse?b=2&a=1&a=%20", headers: { "Content-Type": "application/json" }, body: "{}", region: "us-east-1", service: "bedrock", credentials: { ...EXAMPLE, sessionToken: "TOK" }, now: new Date("2015-08-30T12:36:00Z") });
  const lines = r.canonicalRequest.split("\n");
  assert.equal(lines[1], "/model/a.b%253A0/converse");
  assert.equal(lines[2], "a=%20&a=1&b=2");
  assert.match(r.canonicalRequest, /content-type:application\/json\nhost:h\.example\.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:TOK\n/);
  assert.equal(r.headers["X-Amz-Security-Token"], "TOK");
  assert.equal(uriEncode("a b*'()!~"), "a%20b%2A%27%28%29%21~");
});

test("event stream: CRC vector, round trip split at every byte, corruption refused", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const a = encodeFrame({ ":message-type": "event", ":event-type": "contentBlockDelta" }, '{"x":1}');
  const b = encodeFrame({ ":message-type": "event", ":event-type": "messageStop" }, "{}");
  const all = Buffer.concat([a, b]);
  const d = new EventStreamDecoder();
  const frames = [];
  for (const byte of all) frames.push(...d.push(Uint8Array.of(byte)));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].headers[":event-type"], "contentBlockDelta");
  assert.equal(frames[0].payload.toString(), '{"x":1}');
  assert.equal(d.pending, 0);
  const bad = Buffer.from(a);
  bad[bad.length - 6] ^= 1;
  assert.throws(() => new EventStreamDecoder().push(bad), /checksum/);
  const huge = Buffer.from(a);
  huge.writeUInt32BE(0x7fffffff, 0);
  assert.throws(() => new EventStreamDecoder().push(huge), /out of range/);
});

function body(...chunks: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(k); c.close(); } });
}
const ev = (type: string, payload: unknown) => encodeFrame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, JSON.stringify(payload));

async function run(frames: Buffer[], owner = "bedrock:m") {
  const tokens: string[] = [];
  const p = bedrockStreamParser(owner, (t) => tokens.push(t));
  const all = Buffer.concat(frames);
  // deliver as two arbitrary chunks to exercise partial frames
  await readEventStream(body(all.subarray(0, 37), all.subarray(37)), (n, raw) => p.event(n, JSON.parse(raw)));
  return { r: p.result(), tokens };
}

test("fixture conversation: text, reasoning, parallel tool calls, usage over ConverseStream", async () => {
  const { r, tokens } = await run([
    ev("messageStart", { role: "assistant" }),
    ev("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "think " } } }),
    ev("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig" } } }),
    ev("contentBlockStop", { contentBlockIndex: 0 }),
    ev("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Hel" } }),
    ev("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "lo" } }),
    ev("contentBlockStop", { contentBlockIndex: 1 }),
    ev("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "t1", name: "read_file" } } }),
    ev("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } }),
    ev("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '"a"}' } } }),
    ev("contentBlockStop", { contentBlockIndex: 2 }),
    ev("contentBlockStart", { contentBlockIndex: 3, start: { toolUse: { toolUseId: "t2", name: "ls" } } }),
    ev("contentBlockStop", { contentBlockIndex: 3 }),
    ev("messageStop", { stopReason: "tool_use" }),
    ev("metadata", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 3 }, metrics: { latencyMs: 1 } }),
  ]);
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.message.content, "Hello");
  assert.deepEqual(tokens, ["Hel", "lo"]);
  assert.deepEqual(r.message.tool_calls!.map((c) => [c.id, c.function.name, c.function.arguments]), [["t1", "read_file", '{"path":"a"}'], ["t2", "ls", "{}"]]);
  assert.deepEqual(r.message.provider_state!.items, [{ reasoningText: { text: "think ", signature: "sig" } }]);
  assert.equal(r.message.provider_state!.owner, "bedrock:m");
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 });
});

test("stream: no messageStop is incomplete; exception frame is a provider error; max_tokens is length", async () => {
  assert.equal((await run([ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } })])).r.finish, "incomplete");
  assert.equal((await run([ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } }), ev("contentBlockStop", { contentBlockIndex: 0 }), ev("messageStop", { stopReason: "max_tokens" })])).r.finish, "length");
  const exc = encodeFrame({ ":message-type": "exception", ":exception-type": "throttlingException" }, '{"message":"slow down"}');
  await assert.rejects(run([exc]), (e: any) => e.name === "ProviderStreamError" && e.errorType === "throttlingException" && /slow down/.test(e.message));
  await assert.rejects(readEventStream(body(ev("messageStop", {}).subarray(0, 20)), () => {}), /inside a frame/);
});

test("non-streamed response maps toolUse, reasoning and stop reasons", () => {
  const r = parseBedrockResponse({ output: { message: { role: "assistant", content: [{ reasoningContent: { redactedContent: "AAA=" } }, { text: "hi" }, { toolUse: { toolUseId: "t", name: "n", input: { a: 1 } } }] } }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } }, "o:m");
  assert.equal(r.finish, "tool_calls");
  assert.equal(r.message.tool_calls![0].function.arguments, '{"a":1}');
  assert.deepEqual(r.message.provider_state!.items, [{ redactedContent: "AAA=" }]);
  assert.equal(parseBedrockResponse({ output: { message: { content: [{ text: "x" }] } }, stopReason: "guardrail_intervened" }, "o:m").finish, "refusal");
  assert.throws(() => parseBedrockResponse({}, "o:m"), /no output message/);
});

test("request: path, system, tool specs, toolResult in a user turn, reasoning replay only to the owner", () => {
  const owner = "bedrock:m";
  const items = [{ reasoningText: { text: "t", signature: "s" } }];
  const msgs: any[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: "c.1", type: "function", function: { name: "ls", arguments: "{}" } }], provider_state: { owner, items, digest: "" } },
    { role: "tool", tool_call_id: "c.1", content: "out" },
  ];
  msgs[2].provider_state.digest = stateDigest(items);
  const tools = [{ type: "function" as const, function: { name: "ls", description: "d", parameters: { type: "object", properties: {} } } }];
  const base = { model: "anthropic.claude-3-5-sonnet-20241022-v2:0", messages: msgs, tools, maxOutputTokens: 4096, owner };
  const plain = buildBedrockRequest({ ...base, stream: false, temperature: 0.2 });
  assert.equal(plain.path, "/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse");
  assert.equal(buildBedrockRequest({ ...base, stream: true }).path.endsWith("/converse-stream"), true);
  const b: any = plain.body;
  assert.deepEqual(b.system, [{ text: "be brief" }]);
  assert.deepEqual(b.inferenceConfig, { maxTokens: 4096, temperature: 0.2 });
  assert.deepEqual(b.messages[1].content, [{ toolUse: { toolUseId: "c_1", name: "ls", input: {} } }]);
  assert.deepEqual(b.messages[2], { role: "user", content: [{ toolResult: { toolUseId: "c_1", content: [{ text: "out" }] } }] });
  assert.equal(b.toolConfig.tools[0].toolSpec.inputSchema.json.type, "object");
  const think: any = buildBedrockRequest({ ...base, stream: false, thinkingBudget: 2000 }).body;
  assert.deepEqual(think.messages[1].content[0], { reasoningContent: items[0] });
  assert.equal(think.additionalModelRequestFields.thinking.budget_tokens, 2000);
  assert.equal(think.inferenceConfig.temperature, undefined);
  const foreign: any = buildBedrockRequest({ ...base, owner: "other:m", stream: false, thinkingBudget: 2000 });
  assert.equal(foreign.droppedState, 1);
});

test("registered: bedrock-converse is native, signs and reads event-stream", () => {
  const w = wireProtocol("bedrock-converse");
  assert.equal(w.native, true);
  assert.ok(w.sign && w.readStream);
});

test("credential chain: env, then credentials file profile, then config file; values never in errors", () => {
  assert.deepEqual(resolveAwsCredentials({ env: { AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S", AWS_SESSION_TOKEN: "T" } }), { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aws-cred-"));
  try {
    fs.mkdirSync(path.join(home, ".aws"));
    fs.writeFileSync(path.join(home, ".aws", "credentials"), "# c\n[default]\naws_access_key_id = DEFID\naws_secret_access_key = DEFSECRET\n\n[work]\naws_access_key_id=WID\naws_secret_access_key=WSECRET\naws_session_token=WTOK\n");
    fs.writeFileSync(path.join(home, ".aws", "config"), "[default]\nregion = eu-west-1\n[profile work]\nregion = us-west-2\n[profile cfg]\naws_access_key_id = CID\naws_secret_access_key = CSECRET\n");
    assert.deepEqual(resolveAwsCredentials({ env: {}, home }), { accessKeyId: "DEFID", secretAccessKey: "DEFSECRET" });
    assert.deepEqual(resolveAwsCredentials({ env: { AWS_PROFILE: "work" }, home }), { accessKeyId: "WID", secretAccessKey: "WSECRET", sessionToken: "WTOK" });
    assert.equal(resolveAwsCredentials({ env: { AWS_PROFILE: "cfg" }, home }).accessKeyId, "CID");
    assert.equal(resolveAwsRegion({ env: { AWS_PROFILE: "work" }, home }), "us-west-2");
    assert.equal(resolveAwsRegion({ env: { AWS_REGION: "ap-south-1" }, home }), "ap-south-1");
    assert.throws(() => resolveAwsCredentials({ env: { AWS_PROFILE: "nope" }, home }), (e: Error) => /profile 'nope'/.test(e.message) && !/DEFSECRET|WSECRET/.test(e.message));
    assert.throws(() => resolveAwsCredentials({ env: { AWS_ACCESS_KEY_ID: "ONLY" }, home }), (e: Error) => !/ONLY/.test(e.message));
    assert.deepEqual(Object.keys(parseIni("[profile a]\nk=v\n[other]\nx=y", true)), ["a"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("signBedrockRequest: region from the host, credentials from env, no value in the error", () => {
  const h = signBedrockRequest({ url: "https://bedrock-runtime.eu-west-1.amazonaws.com/model/m/converse", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, { env: { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" } }, new Date("2026-01-01T00:00:00Z"));
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20260101\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.throws(() => signBedrockRequest({ url: "https://proxy.example.com/x", method: "POST", headers: {}, body: "" }, { env: { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" }, home: "/nonexistent-home" }), /no AWS region/);
});
