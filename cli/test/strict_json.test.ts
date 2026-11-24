/**
 * HK-1: the strict JSON reader and the hardened file open behind hooks.json and extension_trust.json. A duplicate key
 * is the case that matters: `JSON.parse` keeps the last one, which would let a later key replace a guard unseen.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeStrictUtf8, fileStamp, parseStrictJson, readHardenedFile, StrictJsonError, type KeyPositions } from "../src/core/strict_json.js";

const rejects = (text: string, pattern: RegExp, options?: Parameters<typeof parseStrictJson>[1]) =>
  assert.throws(() => parseStrictJson(text, options), (error: unknown) => error instanceof StrictJsonError && pattern.test(error.message), text);

test("valid JSON parses to the same value JSON.parse gives", () => {
  for (const text of ['{"a":1,"b":[true,false,null,"x\\n\\u00e9\\"",-1.5e3],"c":{"d":{}}}', "[]", '"s"', " 12 ", "null", '{"a":\n  [1,\n 2]}']) {
    assert.deepEqual(parseStrictJson(text), JSON.parse(text), text);
  }
});

test("a duplicate key is refused at any depth, with the line and column of the second one", () => {
  rejects('{"a":1,"a":2}', /^line 1, column 8: duplicate key "a" \(first at line 1\)$/);
  rejects('{\n "hooks": {\n  "pre-tool": [],\n  "pre-tool": []\n }\n}', /^line 4, column 3: duplicate key "pre-tool" \(first at line 3\)$/);
  rejects('{"a":[{"b":{"c":1,"d":2,"c":3}}]}', /duplicate key "c"/);
  // The same key in two different objects is not a duplicate.
  assert.deepEqual(parseStrictJson('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  // An escaped spelling of the same key is the same key.
  rejects('{"a":1,"\\u0061":2}', /duplicate key "a"/);
});

test("__proto__ is an ordinary key and cannot change the object's prototype", () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
});

test("nesting deeper than the limit is refused", () => {
  assert.deepEqual(parseStrictJson("[[[[[[[[1]]]]]]]]"), [[[[[[[[1]]]]]]]]);
  rejects("[[[[[[[[[1]]]]]]]]]", /nesting is deeper than 8 levels/);
  rejects('{"a":{"b":{"c":1}}}', /nesting is deeper than 2 levels/, { maxDepth: 2 });
  // Deep input is refused by the limit, not by running out of stack.
  rejects("[".repeat(100_000), /nesting is deeper than 8 levels/);
});

test("syntax errors are refused with a position", () => {
  rejects("", /unexpected end of input/);
  rejects('{"a":1,}', /line 1, column 8: expected a string key/);
  rejects("{'a':1}", /expected a string key/);
  rejects('{"a":1} x', /unexpected content after the JSON value/);
  rejects('{"a":01}', /expected ',' or '}'/);
  rejects('["a\nb"]', /control character in a string/);
  rejects('["\\x"]', /invalid escape/);
  rejects('{"a":1 // c\n}', /expected ',' or '}'/);
  rejects('{"a":NaN}', /unexpected character/);
  rejects('"abc', /unterminated string/);
});

test("key positions are recorded for the caller's own messages", () => {
  const positions: KeyPositions = new WeakMap();
  const parsed = parseStrictJson('{\n  "version": 1,\n  "hooks": {\n    "tool": 1\n  }\n}', { positions }) as any;
  assert.deepEqual(positions.get(parsed)?.get("hooks"), { line: 3, column: 3 });
  assert.deepEqual(positions.get(parsed.hooks)?.get("tool"), { line: 4, column: 5 });
});

test("text must be UTF-8 without a byte order mark or NUL", () => {
  assert.equal(decodeStrictUtf8(Buffer.from("{\"é\":1}")), '{"é":1}');
  assert.throws(() => decodeStrictUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), /byte order mark/);
  assert.throws(() => decodeStrictUtf8(Buffer.from([0x7b, 0x00, 0x7d])), /NUL/);
  assert.throws(() => decodeStrictUtf8(Buffer.from([0x22, 0xff, 0xfe, 0x22])), /not valid UTF-8/);
  assert.throws(() => decodeStrictUtf8(Buffer.from([0x22, 0xc3, 0x22])), /not valid UTF-8/);
});

test("the hardened open reads a private regular file and refuses anything else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-strict-json-"));
  try {
    const file = path.join(dir, "hooks.json");
    assert.equal(readHardenedFile(file, { maxBytes: 64, forbiddenMode: 0o022 }), undefined, "an absent file is not an error");

    fs.writeFileSync(file, '{"a":1}', { mode: 0o600 });
    const read = readHardenedFile(file, { maxBytes: 64, forbiddenMode: 0o022 });
    assert.equal(read?.bytes.toString(), '{"a":1}');
    assert.match(read!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(read!.stamp, fileStamp(file), "the stamp of the bytes read is the stamp a later stat gives");

    const refused = (target: string, options: Parameters<typeof readHardenedFile>[1], pattern: RegExp) =>
      assert.throws(() => readHardenedFile(target, options), (error: unknown) => error instanceof StrictJsonError && pattern.test(error.message));

    // Writable by the group or by others: someone else can change what runs.
    fs.chmodSync(file, 0o620);
    refused(file, { maxBytes: 64, forbiddenMode: 0o022 }, /permissions are too open \(mode 620; clear 020\)/);
    fs.chmodSync(file, 0o602);
    refused(file, { maxBytes: 64, forbiddenMode: 0o022 }, /permissions are too open/);
    // Readable by others is fine for configuration, and refused for a private store.
    fs.chmodSync(file, 0o644);
    assert.ok(readHardenedFile(file, { maxBytes: 64, forbiddenMode: 0o022 }));
    refused(file, { maxBytes: 64, forbiddenMode: 0o077 }, /permissions are too open \(mode 644; clear 044\)/);
    // Without a mode rule (content trusted by hash) the same file is read.
    fs.chmodSync(file, 0o666);
    assert.ok(readHardenedFile(file, { maxBytes: 64 }));
    fs.chmodSync(file, 0o600);

    const link = path.join(dir, "link.json");
    fs.symlinkSync(file, link);
    refused(link, { maxBytes: 64 }, /must not be a symbolic link/);
    refused(dir, { maxBytes: 64 }, /must be a regular file/);

    fs.writeFileSync(file, "x".repeat(65));
    refused(file, { maxBytes: 64 }, /exceeds the/);
    fs.writeFileSync(file, "x".repeat(64));
    assert.equal(readHardenedFile(file, { maxBytes: 64 })?.bytes.length, 64);

    // A changed file has a different stamp even when its size is the same.
    const before = fileStamp(file);
    fs.writeFileSync(file, "y".repeat(64));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.notEqual(fileStamp(file), before);
    assert.equal(fileStamp(path.join(dir, "missing")), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file owned by another user is refused when ownership is checked", { skip: process.getuid?.() === 0 ? "root owns everything it can read" : false }, () => {
  // A file of a third user cannot be created without privileges, so the effective uid is stubbed instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-strict-json-"));
  const original = process.geteuid;
  try {
    const file = path.join(dir, "f.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    process.geteuid = () => (original!.call(process) as number) + 1;
    assert.throws(() => readHardenedFile(file, { maxBytes: 64, forbiddenMode: 0o022 }), /owned by another user/);
    assert.ok(readHardenedFile(file, { maxBytes: 64 }), "no ownership rule, no refusal");
  } finally {
    process.geteuid = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
