/**
 * CS-3: the same tool call with identical arguments and an identical result, repeated, is a loop whatever the timing:
 * a corrective note at the soft threshold, a BLOCKED TOOL_CALL_LOOP turn at the hard one. A changed result is progress.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { assertTurnResultInvariants, summarizeTurn, type TurnResult } from "../src/core/turn.js";
import { callKey, judgeRepeatedCalls, repeatedCallHistory, type ToolCallRecord } from "../src/core/repeated_calls.js";

const call = (name: string, args: unknown, result = "same"): ToolCallRecord => ({ name, args: JSON.stringify(args), result });

describe("CS-3 judgeRepeatedCalls", () => {
  test("identical arguments and identical result: soft at 3, hard at 5, none below", () => {
    const calls = Array.from({ length: 5 }, () => call("read_file", { path: "a" }));
    assert.deepEqual(judgeRepeatedCalls(calls.slice(0, 2)), { level: "none", count: 2 });
    assert.equal(judgeRepeatedCalls(calls.slice(0, 3)).level, "soft");
    assert.equal(judgeRepeatedCalls(calls.slice(0, 4)).level, "soft");
    const hard = judgeRepeatedCalls(calls);
    assert.equal(hard.level, "hard");
    assert.equal(hard.count, 5);
  });

  test("same arguments but a changed result is progress", () => {
    const calls = Array.from({ length: 8 }, (_, i) => call("read_file", { path: "a" }, `v${i}`));
    assert.deepEqual(judgeRepeatedCalls(calls), { level: "none", count: 1 });
  });

  test("argument key order does not hide a repeat; different arguments are different calls", () => {
    assert.equal(callKey("t", '{"a":1,"b":{"y":2,"x":1}}'), callKey("t", '{"b":{"x":1,"y":2},"a":1}'));
    const calls = [call("t", { a: 1, b: 2 }), call("t", { b: 2, a: 1 }), call("t", { a: 1, b: 3 }), call("t", { b: 2, a: 1 })];
    assert.equal(judgeRepeatedCalls(calls).count, 3);
    assert.equal(judgeRepeatedCalls(calls, 3, 5).level, "soft");
  });

  test("other calls interleaved do not reset the count, the window bounds it", () => {
    const loop = call("read_file", { path: "a" });
    const mixed = [loop, call("grep", { q: 1 }, "x"), loop, call("grep", { q: 2 }, "y"), loop];
    assert.equal(judgeRepeatedCalls(mixed).level, "soft");
    const old = [loop, loop, ...Array.from({ length: 12 }, (_, i) => call("ls", { i }, `r${i}`)), loop];
    assert.equal(judgeRepeatedCalls(old).count, 1);
    assert.equal(judgeRepeatedCalls(old, 3, 5, 20).count, 3);
  });

  test("a rerun that differs only in duration is the same result", () => {
    const run = (ms: number) => call("run_command", { command: "make" }, `{"exit_code": 1, "duration_ms": ${ms}, "stdout": "broken"}`);
    assert.equal(judgeRepeatedCalls([run(51), run(61), run(55)]).level, "soft");
  });

  test("thresholds are configurable and an empty history is none", () => {
    const calls = [call("t", {}), call("t", {})];
    assert.equal(judgeRepeatedCalls(calls, 2, 2).level, "hard");
    assert.equal(judgeRepeatedCalls(calls, 2, 4).level, "soft");
    assert.deepEqual(judgeRepeatedCalls([]), { level: "none", count: 0 });
  });

  test("the history groups identical calls and redacts arguments", () => {
    const secret = { path: "a", note: "sk-abcdefghijklmnopqrstuvwxyz123456" };
    const h = repeatedCallHistory([call("read_file", secret), call("grep", { q: 1 }, "x"), call("read_file", secret)]);
    assert.equal(h[0].count, 2);
    assert.equal(h[0].tool, "read_file");
    assert.ok(!JSON.stringify(h).includes("sk-abcdefgh"));
    assert.match(h[0].arguments, /REDACTED/);
  });
});

describe("CS-3 TurnResult", () => {
  test("TOOL_CALL_LOOP needs BLOCKED, NOT_ESTABLISHED and the repeated call", () => {
    const base = { execution: "BLOCKED", outcome: "NOT_ESTABLISHED", acceptance: "NOT_REQUESTED", reason: "TOOL_CALL_LOOP", modelStop: "NONE", finalOutputComplete: false, detail: "d", steps: { used: 1, max: 5 } } as unknown as TurnResult;
    assert.throws(() => assertTurnResultInvariants(base), /TOOL_CALL_LOOP requires/);
    const ok = assertTurnResultInvariants({ ...base, repeatedCall: { tool: "t", arguments: "{}", count: 5, history: [] } });
    assert.match(summarizeTurn(ok).line, /TOOL_CALL_LOOP: d.*Nothing is verified/);
  });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, extra: Partial<typeof DEFAULT_CONTINUATION> = {}): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, ...extra },
});
const read: Reply = { kind: "tools", calls: [{ name: "read_file", args: { path: "a.txt" } }] };
const script = (...replies: Reply[]) => (n: number): Reply => replies[n - 1] ?? { kind: "text", content: "finished" };

const write = (content: string): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: "a.txt", content, overwrite: true } }] });
const failing: Reply = { kind: "tools", calls: [{ name: "run_command", args: { command: "echo broken; exit 1" } }] };
const noContinuation = (c: HarnessConfig): HarnessConfig => ({ ...c, continuation: undefined });

describe("CS-3 at the agent layer", () => {
  test("five identical read_file calls without continuation: a note at 3, BLOCKED TOOL_CALL_LOOP at 5 with history", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ "a.txt": "hello\n" });
    const gw = await startGateway(script(read, read, read, read, read, read, read));
    const agent = quiet(new AutonomousAgent(noContinuation(cfg(gw.url, repo))));
    try {
      const turn = await agent.runTurn("Read a.txt.");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.tool, "read_file");
      assert.equal(turn.repeatedCall?.count, 5);
      assert.deepEqual(turn.repeatedCall?.history, [{ tool: "read_file", arguments: '{"path":"a.txt"}', count: 5 }]);
      assert.equal(gw.requests.length, 5, "no request after the fifth call");
      const said = (n: number) => (agent as any).messages.filter((m: any) => typeof m.content === "string" && m.content.includes(`with the same arguments ${n} times and got`)).length;
      assert.equal(said(3), 1);
      assert.equal(said(4), 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failing command repeated between edits that change the workspace is stopped; the tracker alone would not", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ "a.txt": "0\n" });
    const gw = await startGateway(script(failing, write("1\n"), failing, write("2\n"), failing, write("3\n"), failing, write("4\n"), failing, write("5\n"), failing));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Fix it.");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.tool, "run_command");
      assert.equal(turn.repeatedCall?.count, 5);
      assert.equal(gw.requests.length, 9);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("identical arguments with a changing result are not stopped", { timeout: 90_000 }, async () => {
    const repo = makeRepo({});
    const bump: Reply = { kind: "tools", calls: [{ name: "run_command", args: { command: "head -c 6 /dev/urandom | base64" } }] };
    const gw = await startGateway(script(bump, bump, bump, bump, bump, bump, bump, { kind: "text", content: "all done" }));
    const agent = quiet(new AutonomousAgent(noContinuation(cfg(gw.url, repo))));
    try {
      const turn = await agent.runTurn("Sample.");
      assert.notEqual(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall, undefined);
      assert.equal(gw.requests.length, 8);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("thresholds come from continuation.repeatedCallSoft/Hard", { timeout: 90_000 }, async () => {
    const repo = makeRepo({ "a.txt": "0\n" });
    const gw = await startGateway(script(failing, write("1\n"), failing, write("2\n"), failing, write("3\n"), failing));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { repeatedCallSoft: 2, repeatedCallHard: 3 })));
    try {
      const turn = await agent.runTurn("Fix it.");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.count, 3);
      assert.equal(gw.requests.length, 5);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
