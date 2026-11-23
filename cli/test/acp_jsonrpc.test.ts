/**
 * AC-1: the framing of the ACP adapter (cli/src/acp/jsonrpc.ts): the bounded line reader, the depth scan, the
 * classification of one line, encoding, the request correlator, and the import rule of every module in cli/src/acp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeEvent } from "../src/protocol.js";
import {
  BoundedLineReader,
  RequestCorrelator,
  encodeMessage,
  errorResponse,
  exceedsDepth,
  isRequestId,
  notification,
  oversizedLineError,
  parseMessage,
  request,
  resultResponse,
  rpcError,
  type LineEvent,
} from "../src/acp/jsonrpc.js";
import { ACP_ERROR, ACP_MAX_JSON_DEPTH, ACP_MAX_LINE_BYTES, ACP_MAX_METHOD_CHARS, ACP_MAX_REQUEST_ID_CHARS, ACP_TOMBSTONE_COUNT } from "../src/acp/types.js";

const bytes = (text: string) => Buffer.from(text, "utf8");
const lines = (events: LineEvent[]) => events.map((event) => (event.kind === "line" ? event.text : "<oversized>"));

test("the reader splits lines across chunks, accepts \\r\\n, ignores blank lines and gives the unterminated last line at the end", () => {
  const reader = new BoundedLineReader(64);
  const seen: LineEvent[] = [];
  for (const chunk of ['{"a"', ":1}\n\n", "  \r\n", '{"b":2}\r\n{"c"', ":3}"]) seen.push(...reader.push(bytes(chunk)));
  assert.deepEqual(lines(seen), ['{"a":1}', '{"b":2}']);
  assert.equal(reader.bufferedBytes, 7);
  assert.deepEqual(lines(reader.end()), ['{"c":3}']);
  assert.equal(reader.bufferedBytes, 0);
  assert.deepEqual(reader.end(), []);
});

test("the reader keeps a multi-byte character that a chunk boundary splits, and copies what it holds", () => {
  const reader = new BoundedLineReader(64);
  const whole = bytes('"é€😀"\n');
  const seen: LineEvent[] = [];
  for (let i = 0; i < whole.length; i++) {
    const chunk = Buffer.from(whole.subarray(i, i + 1));
    seen.push(...reader.push(chunk));
    chunk.fill(0x41); // the caller reuses its buffer
  }
  assert.deepEqual(lines(seen), ['"é€😀"']);
});

test("the line cap: exactly at the cap is a line, one byte over is oversized, reported once, and the next line is read", () => {
  const cap = 16;
  for (const terminator of ["\n", "\r\n"]) {
    const reader = new BoundedLineReader(cap);
    // The cap counts the bytes before the newline; with \r\n the \r is one of them.
    const body = "x".repeat(cap - (terminator.length - 1));
    assert.deepEqual(lines(reader.push(bytes(`${body}${terminator}`))), [body]);
    assert.equal(reader.oversizedLines, 0);
  }
  const reader = new BoundedLineReader(cap);
  assert.deepEqual(lines(reader.push(bytes(`${"x".repeat(cap + 1)}\nok\n`))), ["<oversized>", "ok"]);
  assert.equal(reader.oversizedLines, 1);
  // Arriving byte by byte: still one report, at the moment the cap is passed.
  const slow = new BoundedLineReader(cap);
  const seen: LineEvent[] = [];
  for (const byte of bytes(`${"y".repeat(cap * 3)}\nnext\n`)) seen.push(...slow.push(Uint8Array.of(byte)));
  assert.deepEqual(lines(seen), ["<oversized>", "next"]);
  // An oversized line that never ends is not turned into a line by the end of the stream.
  const open = new BoundedLineReader(cap);
  assert.deepEqual(lines(open.push(bytes("z".repeat(cap + 5)))), ["<oversized>"]);
  assert.deepEqual(open.end(), []);
});

test("a 4 MiB line arriving in small chunks is never buffered past the cap: the reader holds nothing once it is over", () => {
  const reader = new BoundedLineReader();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const seen: LineEvent[] = [];
  let largest = 0;
  let sent = 0;
  // Three times the cap, with no newline.
  while (sent < ACP_MAX_LINE_BYTES * 3) {
    seen.push(...reader.push(chunk));
    sent += chunk.length;
    largest = Math.max(largest, reader.bufferedBytes);
    if (sent > ACP_MAX_LINE_BYTES) assert.equal(reader.bufferedBytes, 0, `held ${reader.bufferedBytes} bytes after ${sent} sent`);
  }
  assert.ok(largest <= ACP_MAX_LINE_BYTES, `the reader held ${largest} bytes`);
  assert.deepEqual(lines(seen), ["<oversized>"], "reported once");
  assert.deepEqual(lines(reader.push(bytes('tail\n{"jsonrpc":"2.0","method":"x"}\n'))), ['{"jsonrpc":"2.0","method":"x"}']);
  assert.equal(reader.oversizedLines, 1);

  // Exactly at the cap is accepted; the answer to an oversized line is a parse error with a null id.
  const exact = new BoundedLineReader();
  const events = exact.push(Buffer.concat([Buffer.alloc(ACP_MAX_LINE_BYTES, 0x62), bytes("\n")]));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind === "line" && events[0].text.length, ACP_MAX_LINE_BYTES);
  assert.deepEqual(oversizedLineError(), { jsonrpc: "2.0", id: null, error: { code: -32700, message: `a message is longer than ${ACP_MAX_LINE_BYTES} bytes and was discarded` } });
});

test("the depth scan allows exactly the limit, refuses one more, and does not count brackets inside strings", () => {
  const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
  assert.equal(exceedsDepth(nested(ACP_MAX_JSON_DEPTH)), false);
  assert.equal(exceedsDepth(nested(ACP_MAX_JSON_DEPTH + 1)), true);
  assert.equal(exceedsDepth(`${'{"a":'.repeat(ACP_MAX_JSON_DEPTH)}1${"}".repeat(ACP_MAX_JSON_DEPTH)}`), false);
  assert.equal(exceedsDepth(`${'{"a":'.repeat(ACP_MAX_JSON_DEPTH + 1)}1${"}".repeat(ACP_MAX_JSON_DEPTH + 1)}`), true);
  assert.equal(exceedsDepth(JSON.stringify({ text: "[".repeat(500) + "{".repeat(500) })), false);
  assert.equal(exceedsDepth(JSON.stringify({ text: `a "quoted" \\ ${"[".repeat(500)}` })), false, "escaped quotes and backslashes do not end the string");
  assert.equal(exceedsDepth(JSON.stringify(["\\", "[".repeat(200)])), false, "a string that ends in a backslash");
  assert.equal(exceedsDepth(`{"k":"${"[".repeat(10)}",${'"n":['.repeat(1)}${nested(ACP_MAX_JSON_DEPTH)}]}`), true, "depth outside strings still counts");
  // Sequential siblings do not accumulate.
  assert.equal(exceedsDepth(`[${Array(1000).fill("[]").join(",")}]`), false);
});

test("a depth bomb and a line that is not JSON are parse errors with a null id, without reaching JSON.parse", () => {
  const original = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsed++;
    return original(...args);
  }) as typeof JSON.parse;
  try {
    const bomb = parseMessage("[".repeat(200_000));
    assert.deepEqual(bomb, { kind: "invalid", id: null, respond: true, error: { code: -32700, message: `the message nests deeper than ${ACP_MAX_JSON_DEPTH} levels` } });
    assert.equal(parsed, 0, "the depth scan refuses before parsing");
    for (const text of ["not json", "{", '{"jsonrpc":"2.0",}', "\u0000", "{\"a\":\u0000}"]) {
      const result = parseMessage(text);
      assert.equal(result.kind, "invalid", text);
      assert.deepEqual(result.kind === "invalid" && [result.id, result.error.code, result.respond], [null, -32700, true], text);
    }
  } finally {
    JSON.parse = original;
  }
});

test("classification: request, notification, response, and each invalid form with its code", () => {
  const line = (value: unknown) => JSON.stringify(value);
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })), { kind: "request", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", id: "a-1", method: "session/new" })), { kind: "request", id: "a-1", method: "session/new", params: undefined });
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } })), { kind: "notification", method: "session/cancel", params: { sessionId: "s" } });
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } })), { kind: "response", id: 7, result: { outcome: { outcome: "cancelled" } } });
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", id: 7, result: null })), { kind: "response", id: 7, result: null });
  assert.deepEqual(parseMessage(line({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "no", data: { a: 1 } } })), { kind: "response", id: 7, error: { code: -32603, message: "no", data: { a: 1 } } });

  const invalid = (value: unknown, code: number, id: unknown, respond: boolean, why: string) => {
    const result = parseMessage(line(value));
    assert.equal(result.kind, "invalid", why);
    assert.deepEqual(result.kind === "invalid" && [result.error.code, result.id, result.respond], [code, id, respond], why);
  };
  // A batch is refused whole (Nexus's own rule: the specification has none).
  invalid([{ jsonrpc: "2.0", id: 1, method: "initialize" }], -32600, null, true, "a batch");
  invalid([], -32600, null, true, "an empty batch");
  assert.match((parseMessage("[]") as any).error.message, /batch requests are not supported/);
  for (const scalar of [1, "text", true, null]) invalid(scalar, -32600, null, true, `a ${typeof scalar} is not a message`);
  // Wrong or missing jsonrpc: the id is echoed when it is a valid one.
  invalid({ id: 1, method: "initialize" }, -32600, 1, true, "no jsonrpc");
  invalid({ jsonrpc: "1.0", id: "x", method: "initialize" }, -32600, "x", true, "jsonrpc 1.0");
  invalid({ jsonrpc: 2, id: 1, method: "initialize" }, -32600, 1, true, "jsonrpc as a number");
  invalid({ jsonrpc: "2.0 ", id: 1, method: "initialize" }, -32600, 1, true, "jsonrpc with a space");
  // Id rules: a string or an integer; null, a fraction and anything else are refused with a null id.
  for (const id of [null, 1.5, true, {}, [], [1], 2 ** 53, "x".repeat(ACP_MAX_REQUEST_ID_CHARS + 1)]) invalid({ jsonrpc: "2.0", id, method: "initialize" }, -32600, null, true, `id ${JSON.stringify(id)?.slice(0, 20)}`);
  for (const id of [0, -1, 2 ** 31, Number.MAX_SAFE_INTEGER, "", "1", "x".repeat(ACP_MAX_REQUEST_ID_CHARS)]) {
    assert.equal(parseMessage(line({ jsonrpc: "2.0", id, method: "initialize" })).kind, "request", `id ${String(id).slice(0, 20)}`);
  }
  assert.equal(isRequestId(1e21), false);
  assert.equal(isRequestId(NaN), false);
  // Method rules.
  invalid({ jsonrpc: "2.0", id: 1, method: 5 }, -32600, 1, true, "a numeric method");
  invalid({ jsonrpc: "2.0", id: 1, method: "" }, -32600, 1, true, "an empty method");
  invalid({ jsonrpc: "2.0", id: 1, method: "m".repeat(ACP_MAX_METHOD_CHARS + 1) }, -32600, 1, true, "a method over the limit");
  assert.equal(parseMessage(line({ jsonrpc: "2.0", id: 1, method: "m".repeat(ACP_MAX_METHOD_CHARS) })).kind, "request");
  invalid({ jsonrpc: "2.0", method: null }, -32600, null, true, "a null method");
  // Reply-shaped messages are never answered.
  invalid({ jsonrpc: "2.0" }, -32600, null, false, "neither method nor id");
  invalid({ jsonrpc: "2.0", id: 7 }, -32600, 7, false, "a reply with neither result nor error");
  invalid({ jsonrpc: "2.0", id: 7, result: 1, error: { code: 1, message: "x" } }, -32600, 7, false, "a reply with both");
  invalid({ jsonrpc: "2.0", id: null, result: 1 }, -32600, null, false, "a reply with a null id");
  invalid({ jsonrpc: "2.0", id: 1.5, result: 1 }, -32600, null, false, "a reply with a fractional id");
  invalid({ jsonrpc: "2.0", id: 7, error: "boom" }, -32600, 7, false, "an error that is not an object");
  invalid({ jsonrpc: "2.0", id: 7, error: { code: "x", message: "m" } }, -32600, 7, false, "an error without a numeric code");
  invalid({ jsonrpc: "1.0", id: 7, result: 1 }, -32600, 7, false, "a reply with the wrong jsonrpc");
  // A member inherited from a prototype is not a member of the message.
  assert.equal(parseMessage('{"jsonrpc":"2.0","__proto__":{"method":"initialize","id":1}}').kind, "invalid");
});

test("encoding: one line per message, no raw newline inside it, lone surrogates replaced as encodeEvent does", () => {
  const hostile = "line one\nline two\r\u2028\u2029\u0000\u0085 tab\t";
  for (const message of [
    resultResponse(1, { text: hostile }),
    errorResponse(null, rpcError(ACP_ERROR.PARSE_ERROR, hostile)),
    notification("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: hostile } } }),
    request(5, "session/request_permission", { [hostile]: hostile }),
  ]) {
    const line = encodeMessage(message);
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.indexOf("\n"), line.length - 1, "the only newline is the terminator");
    assert.equal(line.includes("\r"), false);
    assert.deepEqual(JSON.parse(line), message, "nothing is lost");
  }
  const cases = ["\uD83D", "\uDE00", "a\uD83Db", "\uDE00\uD83D", "ok 😀 pair", "\uD83D😀", "😀\uDE00"];
  for (const text of cases) {
    const ours = JSON.parse(encodeMessage({ text })).text;
    const sidecar = JSON.parse(encodeEvent({ type: "notice", text })).text;
    assert.equal(ours, sidecar, JSON.stringify(text));
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(ours), false);
    assert.equal(Buffer.from(encodeMessage({ text }), "utf8").toString("utf8"), encodeMessage({ text }), "the line survives UTF-8");
  }
  assert.equal(JSON.parse(encodeMessage({ text: "ok 😀 pair" })).text, "ok 😀 pair", "a whole pair is kept");
  assert.deepEqual(resultResponse("a", 1), { jsonrpc: "2.0", id: "a", result: 1 });
  assert.deepEqual(request(3, "m", { a: 1 }), { jsonrpc: "2.0", id: 3, method: "m", params: { a: 1 } });
});

test("the correlator: integer ids from a random 31-bit start, each answered once, stale told apart from unknown", () => {
  const starts = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const id = new RequestCorrelator<string>().open("x");
    assert.ok(Number.isInteger(id) && id >= 1 && id <= 0x7fffffff, `id ${id}`);
    starts.add(id);
  }
  assert.ok(starts.size > 30, "the start is random");

  const correlator = new RequestCorrelator<string>({ start: 100 });
  const first = correlator.open("approval-1");
  const second = correlator.open("approval-2");
  assert.deepEqual([first, second, correlator.pending], [100, 101, 2]);
  // A reply before its request exists, a guess, and ids of the wrong type match nothing.
  for (const guess of [102, 99, 0, -100, "100", 100.5, null, undefined, {}, [100], true]) assert.deepEqual(correlator.settle(guess), { state: "unknown" }, String(guess));
  assert.equal(correlator.pending, 2);
  assert.deepEqual(correlator.settle(first), { state: "matched", context: "approval-1" });
  assert.deepEqual(correlator.settle(first), { state: "stale" }, "a second reply");
  assert.deepEqual(correlator.settle(first), { state: "stale" });
  // Abandoned (cancel, timeout, turn end): the late reply is stale, not a match.
  assert.equal(correlator.abandon(second), "approval-2");
  assert.equal(correlator.abandon(second), undefined);
  assert.deepEqual(correlator.settle(second), { state: "stale" });
  assert.equal(correlator.pending, 0);
  assert.equal(correlator.open("approval-3"), 102);
});

test("the correlator remembers exactly the last 256 closed ids, wraps at 2^31-1, and never reissues an open id", () => {
  const correlator = new RequestCorrelator<number>({ start: 1 });
  const ids: number[] = [];
  for (let i = 0; i < ACP_TOMBSTONE_COUNT + 1; i++) ids.push(correlator.open(i));
  for (const id of ids.slice(0, ACP_TOMBSTONE_COUNT)) correlator.abandon(id);
  assert.deepEqual(correlator.settle(ids[0]), { state: "stale" }, "exactly at the limit: the oldest is still remembered");
  correlator.abandon(ids[ACP_TOMBSTONE_COUNT]);
  assert.deepEqual(correlator.settle(ids[0]), { state: "unknown" }, "one over: the oldest is forgotten");
  assert.deepEqual(correlator.settle(ids[1]), { state: "stale" });
  assert.deepEqual(correlator.settle(ids[ACP_TOMBSTONE_COUNT]), { state: "stale" });

  const wrapping = new RequestCorrelator<string>({ start: 0x7fffffff });
  const last = wrapping.open("a");
  const one = wrapping.open("b");
  assert.deepEqual([last, one], [0x7fffffff, 1]);
  const again = new RequestCorrelator<string>({ start: 0x7ffffffe, tombstones: 2 });
  const a = again.open("a");
  const b = again.open("b");
  const c = again.open("c");
  assert.deepEqual([a, b, c], [0x7ffffffe, 0x7fffffff, 1]);
  assert.throws(() => new RequestCorrelator({ start: 0 }), RangeError);
  assert.throws(() => new RequestCorrelator({ start: 2 ** 31 }), RangeError);
  assert.throws(() => new RequestCorrelator({ start: 1.5 }), RangeError);
});

/**
 * The modules of cli/src/acp are pure: a node built-in, another module of the directory, `core/unified_diff.ts`,
 * `safe_text.ts`, or a type-only import. Nothing that performs I/O when imported (commander, the agent, the sidecar
 * server) can enter, because nothing else may be imported for its value.
 */
test("the import graph of cli/src/acp stays inside its allowlist", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "acp");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".ts")).sort();
  assert.deepEqual(files, ["jsonrpc.ts", "mapping.ts", "types.ts", "validate.ts"], "a new module in cli/src/acp is checked here: add it deliberately");
  const valueAllowed = (specifier: string) =>
    /^node:(crypto|path|url)$/.test(specifier) || /^\.\/(jsonrpc|mapping|types|validate)\.js$/.test(specifier) || specifier === "../core/unified_diff.js" || specifier === "../safe_text.js";
  const typeAllowed = (specifier: string) => valueAllowed(specifier) || /^\.\.\/(protocol|evidence|approval_review|core\/turn|verify_contract)\.js$/.test(specifier);
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\brequire\s*\(|\bimport\s*\(/.test(code), false, `${file}: no require() and no dynamic import()`);
    assert.equal(/\bimport\s*\{[^}]*\btype\s/.test(code), false, `${file}: write type imports as \`import type\`, so this check can tell them apart`);
    assert.equal(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\b/m.test(code), false, `${file}: no re-export from another module`);
    const imports = [...code.matchAll(/^\s*import\s+(type\s+)?(?:[\s\S]*?)\s+from\s+"([^"]+)";/gm)];
    const bare = [...code.matchAll(/^\s*import\s+"([^"]+)";/gm)];
    assert.deepEqual(bare.map((m) => m[1]), [], `${file}: no side-effect import`);
    assert.equal(imports.length, [...code.matchAll(/^\s*import\b/gm)].length, `${file}: every import statement was read`);
    for (const [, typeOnly, specifier] of imports) {
      assert.ok(typeOnly ? typeAllowed(specifier) : valueAllowed(specifier), `${file}: ${typeOnly ? "type " : ""}import of ${specifier} is outside the allowlist`);
    }
  }
});
