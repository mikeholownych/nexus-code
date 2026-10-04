import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capText, encodeEvent, parseCommand, ProtocolError, toolSubject, toolSummary, MAX_TEXT_FIELD } from "../src/protocol.js";

describe("protocol: encodeEvent", () => {
  test("emits one versioned JSON line", () => {
    const line = encodeEvent({ type: "assistant.delta", turn_id: "t1", text: "hi" });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), { v: 1, type: "assistant.delta", turn_id: "t1", text: "hi" });
  });
});

describe("protocol: parseCommand", () => {
  test("accepts every command type", () => {
    assert.deepEqual(parseCommand('{"v":1,"type":"prompt.submit","id":"t1","text":"fix it"}'), { type: "prompt.submit", id: "t1", text: "fix it" });
    assert.deepEqual(parseCommand('{"v":1,"type":"cancel"}'), { type: "cancel" });
    assert.deepEqual(parseCommand('{"v":1,"type":"approve","id":"a1"}'), { type: "approve", id: "a1", always: false });
    assert.deepEqual(parseCommand('{"v":1,"type":"approve","id":"a1","always":true}'), { type: "approve", id: "a1", always: true });
    assert.deepEqual(parseCommand('{"v":1,"type":"deny","id":"a1"}'), { type: "deny", id: "a1" });
    assert.deepEqual(parseCommand('{"v":1,"type":"slash","id":"s1","command":"status"}'), { type: "slash", id: "s1", command: "status", args: "" });
    assert.deepEqual(parseCommand('{"v":1,"type":"shutdown"}'), { type: "shutdown" });
  });

  test("rejects malformed input with ProtocolError, keeping the id when present", () => {
    assert.throws(() => parseCommand("not json"), ProtocolError);
    assert.throws(() => parseCommand("[1,2]"), ProtocolError);
    assert.throws(() => parseCommand('{"v":2,"type":"cancel"}'), /unsupported protocol version/);
    assert.throws(() => parseCommand('{"v":1,"type":"prompt.submit","text":"x"}'), /requires id/);
    assert.throws(() => parseCommand('{"v":1,"type":"bogus","id":"z"}'), (err: unknown) => err instanceof ProtocolError && err.id === "z");
    assert.throws(() => parseCommand('{"v":1,"type":"prompt.submit","id":"t9","text":"   "}'), (err: unknown) => err instanceof ProtocolError && err.id === "t9");
  });
});

describe("protocol: projection helpers", () => {
  test("capText truncates oversized fields and says so", () => {
    const capped = capText("x".repeat(MAX_TEXT_FIELD + 50));
    assert.ok(capped.startsWith("x".repeat(MAX_TEXT_FIELD)));
    assert.ok(capped.endsWith("…[truncated 50 chars]"));
    assert.equal(capText("short"), "short");
  });

  test("toolSubject picks the primary argument and redacts secrets", () => {
    assert.equal(toolSubject({ path: "src/a.ts" }), "src/a.ts");
    assert.equal(toolSubject({ command: "npm   test\n--watch" }), "npm test --watch");
    assert.equal(toolSubject({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'" }).includes("abcdefghijklmnop"), false);
    assert.equal(toolSubject({}), "");
  });

  test("toolSummary reports the first meaningful line and line count", () => {
    assert.deepEqual(toolSummary(true, "\nfirst line\nsecond\n"), { summary: "first line", lines: 2 });
    assert.deepEqual(toolSummary(true, ""), { summary: "Completed", lines: 0 });
    assert.deepEqual(toolSummary(false, "", "boom happened"), { summary: "boom happened", lines: 1 });
  });
});
