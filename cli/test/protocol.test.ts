import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { capText, encodeEvent, parseCommand, projectTurn, ProtocolError, toolSubject, toolSummary, MAX_TEXT_FIELD } from "../src/protocol.js";
import type { TurnResult } from "../src/core/turn.js";

describe("protocol: encodeEvent", () => {
  test("emits one versioned JSON line", () => {
    const line = encodeEvent({ type: "assistant.delta", turn_id: "t1", text: "hi" });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), { v: 1, type: "assistant.delta", turn_id: "t1", text: "hi" });
  });

  test("never emits a lone UTF-16 surrogate, even when truncation splits an emoji", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const { summary, lines } = toolSummary(true, "a" + "😀".repeat(200));
    assert.ok(lone.test(summary), "the fixture must split a surrogate pair");
    const line = encodeEvent({ type: "tool.end", turn_id: "t1", call_id: "c1", tool: "run_command", success: true, summary, lines });
    assert.equal(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(line), false, line);
    const parsed = JSON.parse(line);
    assert.equal(lone.test(parsed.summary), false);
    assert.ok(parsed.summary.startsWith("a😀"));
    assert.ok(parsed.summary.endsWith("\uFFFD"));
    const subject = toolSubject({ command: "😀".repeat(150) });
    const start = JSON.parse(encodeEvent({ type: "tool.start", turn_id: "t1", call_id: "c2", tool: "run_command", subject }));
    assert.equal(lone.test(start.subject), false);
    assert.equal(JSON.parse(encodeEvent({ type: "assistant.delta", turn_id: "t1", text: "x\uDE00y😀" })).text, "x\uFFFDy😀");
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
    assert.deepEqual(parseCommand('{"v":1,"type":"tool.detail","id":"d1","evidence":"e3"}'), { type: "tool.detail", id: "d1", evidence: "e3" });
    assert.deepEqual(parseCommand('{"v":1,"type":"receipt","id":"r1"}'), { type: "receipt", id: "r1" });
  });

  test("tool.detail needs an evidence id and receipt needs a request id", () => {
    assert.throws(() => parseCommand('{"v":1,"type":"tool.detail","id":"d1"}'), (err: unknown) => err instanceof ProtocolError && err.id === "d1" && /requires evidence/.test(err.message));
    assert.throws(() => parseCommand('{"v":1,"type":"receipt"}'), /receipt requires id/);
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

  test("tool summaries and subjects drop terminal escape sequences", () => {
    assert.equal(toolSummary(false, "\x1b[31mFAIL\x1b[39m src/a.test.ts\n").summary, "FAIL src/a.test.ts");
    assert.equal(toolSummary(true, "\x1b]8;;https://x.test\x07link\x1b]8;;\x07 done").summary, "link done");
    assert.equal(toolSubject({ command: "echo \x1b[1;32mok\x1b[0m\x1bc" }), "echo ok");
    const colored = "\x1b[32m" + "y".repeat(300) + "\x1b[0m";
    assert.equal(toolSummary(true, colored).summary, "y".repeat(160));
  });

  test("projectTurn redacts every free-text field and leaves the rest intact", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123";
    const turn: TurnResult = Object.freeze({
      execution: "FAILED",
      outcome: "NOT_ESTABLISHED",
      acceptance: "NOT_REQUESTED",
      reason: "INFERENCE_FAILED",
      detail: `boom ${secret}`,
      modelStop: "NONE",
      finalOutputComplete: false,
      verification: { status: "FAILED", command: `curl -H '${secret}'`, source: "configured", exitSuccess: false, outputSha256: "abc123", at: "2026-01-01T00:00:00Z" },
      interruption: { requestedAt: "2026-01-01T00:00:00Z", phase: "tool_dispatch", outstandingTool: `run ${secret}`, outstandingToolSettled: false, undispatchedToolCalls: 1 },
      inferenceFailure: { kind: "http_error", origin: "provider", message: `HTTP 500: ${secret}`, httpStatus: 500, requestId: "req-1" },
      steps: { used: 1, max: 6, limitReached: false },
      unverifiedChangesPending: false,
      finishedAt: "2026-01-01T00:00:00Z",
    });
    const projected = projectTurn(turn);
    assert.equal(JSON.stringify(projected).includes("abcdefghijklmnopqrstuvwxyz0123"), false);
    assert.equal(projected.detail, "boom Bearer [REDACTED:BEARER_AUTH_HEADER]");
    assert.equal(projected.inferenceFailure?.message, "HTTP 500: Bearer [REDACTED:BEARER_AUTH_HEADER]");
    assert.equal(projected.verification?.command, "curl -H 'Bearer [REDACTED:BEARER_AUTH_HEADER]'");
    assert.equal(projected.interruption?.outstandingTool, "run Bearer [REDACTED:BEARER_AUTH_HEADER]");
    assert.deepEqual({ ...projected, detail: turn.detail, inferenceFailure: turn.inferenceFailure, verification: turn.verification, interruption: turn.interruption }, turn);
    assert.equal(projected.inferenceFailure?.requestId, "req-1");
    assert.equal(projected.verification?.outputSha256, "abc123");

    const bare = projectTurn({ ...turn, detail: undefined, verification: null, interruption: null, inferenceFailure: null });
    assert.equal(bare.detail, undefined);
    assert.equal(bare.verification, null);
    assert.equal(bare.interruption, null);
    assert.equal(bare.inferenceFailure, null);
  });
});
