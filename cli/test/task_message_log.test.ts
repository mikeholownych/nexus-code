import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChatMessage } from "../src/types.js";
import { appendTaskMessages, readTaskMessages, TaskMessageLogError, type TaskMessageCursor } from "../src/core/task_message_log.js";

const task = "message-log-fixture";
const message = (content: string): ChatMessage => ({ role: "user", content });
const corrupt = (error: unknown): boolean => error instanceof TaskMessageLogError && error.kind === "corrupt";

function fixture(run: (file: string, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-message-log-"));
  try { run(path.join(root, "private", "messages.jsonl"), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("message log appends new messages and leaves every previous commit readable", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(first);
  const originalBytes = fs.readFileSync(file);
  const next = appendTaskMessages(file, task, first, [message("one")], [message("one"), message("two")]);
  assert.ok(next);
  assert.deepEqual(fs.readFileSync(file).subarray(0, originalBytes.length), originalBytes);
  assert.deepEqual(readTaskMessages(file, task, first), [message("one")]);
  assert.deepEqual(readTaskMessages(file, task, next), [message("one"), message("two")]);
}));

test("unchanged or initially empty conversations do not append unnecessary data", () => fixture(file => {
  assert.equal(appendTaskMessages(file, task, null, [], []), null);
  assert.equal(fs.existsSync(file), false);
  const first = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(first);
  const before = fs.readFileSync(file);
  assert.deepEqual(appendTaskMessages(file, task, first, [message("one")], [message("one")]), first);
  assert.deepEqual(fs.readFileSync(file), before);
}));

test("edits, shortened history and compaction select a new branch without deleting originals", () => fixture(file => {
  const original = [message("one"), message("two"), message("three")];
  const first = appendTaskMessages(file, task, null, [], original);
  assert.ok(first);
  const edited = [message("one"), message("corrected")];
  const second = appendTaskMessages(file, task, first, original, edited);
  assert.ok(second);
  const compacted = [message("summary")];
  const third = appendTaskMessages(file, task, second, edited, compacted);
  assert.deepEqual(readTaskMessages(file, task, third), compacted);
  assert.deepEqual(readTaskMessages(file, task, second), edited);
  assert.deepEqual(readTaskMessages(file, task, first), original);
}));

test("torn and complete unpublished appends cannot become part of a later committed branch", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("committed")]);
  assert.ok(first);
  const unpublished = appendTaskMessages(file, task, first, [message("committed")], [message("committed"), message("unpublished")]);
  assert.ok(unpublished);
  fs.appendFileSync(file, '{"torn":');
  assert.deepEqual(readTaskMessages(file, task, first), [message("committed")]);
  const recovered = appendTaskMessages(file, task, first, [message("committed")], [message("committed"), message("retry")]);
  assert.deepEqual(readTaskMessages(file, task, recovered), [message("committed"), message("retry")]);
  assert.deepEqual(readTaskMessages(file, task, unpublished), [message("committed"), message("unpublished")]);
}));

test("a displaced byte hint resolves by committed digest instead of returning another append", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(first);
  assert.deepEqual(readTaskMessages(file, task, { ...first, offset: first.offset + 1 }), [message("one")]);
}));

test("a writer cannot claim a prefix different from its committed parent", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(first);
  const before = fs.readFileSync(file);
  assert.throws(() => appendTaskMessages(file, task, first, [message("forged")], [message("forged"), message("two")]), corrupt);
  assert.deepEqual(fs.readFileSync(file), before);
}));

test("corrupt committed data fails closed, including damage to an ancestor", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("original")]);
  assert.ok(first);
  const second = appendTaskMessages(file, task, first, [message("original")], [message("original"), message("later")]);
  assert.ok(second);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("original", "damaged!"));
  assert.throws(() => readTaskMessages(file, task, first), corrupt);
  assert.throws(() => readTaskMessages(file, task, second), corrupt);
}));

test("a different task identity or incorrect committed count is refused", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(first);
  assert.throws(() => readTaskMessages(file, "another-task", first), corrupt);
  assert.throws(() => readTaskMessages(file, task, { ...first, count: 2 }), corrupt);
}));

test("future cursor schemas fail before touching the named file", () => fixture(file => {
  const cursor = { schemaVersion: 99, sha256: "0".repeat(64), offset: 0, bytes: 1, count: 0 } as unknown as TaskMessageCursor;
  assert.throws(() => readTaskMessages(file, task, cursor), error => error instanceof TaskMessageLogError && error.kind === "future" && error.version === 99);
  assert.equal(fs.existsSync(file), false);
}));

test("future message-record schemas are preserved and reported without mutation", () => fixture(file => {
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 99, taskId: task }));
  fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from("\n")]), { mode: 0o600 });
  const cursor: TaskMessageCursor = { schemaVersion: 2, sha256: createHash("sha256").update(bytes).digest("hex"), offset: 0, bytes: bytes.length, count: 0 };
  const before = fs.readFileSync(file);
  assert.throws(() => readTaskMessages(file, task, cursor), error => error instanceof TaskMessageLogError && error.kind === "future");
  assert.deepEqual(fs.readFileSync(file), before);
}));

test("redirected and hard-linked logs cannot redirect either reads or writes", () => fixture((file, root) => {
  const cursor = appendTaskMessages(file, task, null, [], [message("one")]);
  assert.ok(cursor);
  const target = path.join(root, "original-log");
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.throws(() => readTaskMessages(file, task, cursor), corrupt);
  assert.throws(() => appendTaskMessages(file, task, null, [], [message("two")]));
  fs.unlinkSync(file);
  fs.linkSync(target, file);
  assert.throws(() => readTaskMessages(file, task, cursor), corrupt);
  assert.deepEqual(readTaskMessagesAfterUnlink(), [message("one")]);
  function readTaskMessagesAfterUnlink(): ChatMessage[] {
    fs.unlinkSync(file);
    return readTaskMessages(target, task, cursor);
  }
}));

test("new message logs and their directories remain private under a permissive umask", () => fixture(file => {
  const old = process.umask(0o002);
  try {
    appendTaskMessages(file, task, null, [], [message("one")]);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
  } finally { process.umask(old); }
}));

test("decoded reuse still detects same-size ancestor tampering with an unchanged committed head", () => fixture(file => {
  const first = appendTaskMessages(file, task, null, [], [message("one")]); assert.ok(first);
  const next = appendTaskMessages(file, task, first, [message("one")], [message("one"), message("two")]); assert.ok(next);
  assert.deepEqual(readTaskMessages(file, task, next), [message("one"), message("two")]);
  const raw = fs.readFileSync(file); const at = raw.indexOf(Buffer.from('"content":"one"')); assert.ok(at >= 0);
  Buffer.from('"content":"bad"').copy(raw, at); fs.writeFileSync(file, raw);
  assert.throws(() => readTaskMessages(file, task, next), corrupt);
}));

test("decoded reuse is isolated from caller mutation and validates the complete cursor", () => fixture(file => {
  const cursor = appendTaskMessages(file, task, null, [], [message("one")]); assert.ok(cursor);
  const read = readTaskMessages(file, task, cursor); read[0].content = "mutated outside the store";
  assert.deepEqual(readTaskMessages(file, task, cursor), [message("one")]);
  assert.throws(() => readTaskMessages(file, task, { ...cursor, count: 2 }), corrupt);
  assert.throws(() => readTaskMessages(file, "different-task", cursor), corrupt);
}));
