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
import { callKey, judgeRepeatedCalls, makeCallRecord, pushCall, repeatedCallHistory, resolveRepeatedCallSettings, type CallClass, type CallRecord } from "../src/core/repeated_calls.js";

const call = (name: string, args: unknown, result = "same", kind: CallClass = "observer", state = "s0") => makeCallRecord(name, JSON.stringify(args), result, kind, state);
const judge = (calls: CallRecord[], soft?: number, hard?: number) => {
  const ring: CallRecord[] = [];
  for (const c of calls) pushCall(ring, c);
  return judgeRepeatedCalls(ring, soft, hard);
};

describe("CS-3 judgeRepeatedCalls", () => {
  test("identical arguments and identical result: soft at 3, hard at 5, none below", () => {
    const calls = Array.from({ length: 5 }, () => call("read_file", { path: "a" }));
    assert.deepEqual(judge(calls.slice(0, 2)), { level: "none", count: 2 });
    assert.equal(judge(calls.slice(0, 3)).level, "soft");
    assert.equal(judge(calls.slice(0, 4)).level, "soft");
    const hard = judge(calls);
    assert.equal(hard.level, "hard");
    assert.equal(hard.count, 5);
  });

  test("same arguments but a changed result is progress", () => {
    const calls = Array.from({ length: 8 }, (_, i) => call("read_file", { path: "a" }, `v${i}`));
    assert.deepEqual(judge(calls), { level: "none", count: 1 });
  });

  test("argument key order does not hide a repeat; different arguments are different calls", () => {
    assert.equal(callKey("t", '{"a":1,"b":{"y":2,"x":1}}'), callKey("t", '{"b":{"x":1,"y":2},"a":1}'));
    const calls = [call("t", { a: 1, b: 2 }), call("t", { b: 2, a: 1 }), call("t", { a: 1, b: 3 }), call("t", { b: 2, a: 1 })];
    assert.equal(judge(calls).count, 3);
    assert.equal(judge(calls, 3, 5).level, "soft");
  });

  test("other calls interleaved do not reset the count; the ring holds 64", () => {
    const loop = call("read_file", { path: "a" });
    assert.equal(judge([loop, call("grep", { q: 1 }, "x"), loop, call("grep", { q: 2 }, "y"), loop]).level, "soft");
    const ring: CallRecord[] = [];
    for (const c of [loop, loop, ...Array.from({ length: 64 }, (_, i) => call("ls", { i }, `r${i}`)), loop]) pushCall(ring, c);
    assert.equal(ring.length, 64);
    assert.equal(judgeRepeatedCalls(ring).count, 1);
    assert.ok(!JSON.stringify(ring).includes("same"), "records hold digests, not result text");
  });

  test("thresholds are configurable and an empty history is none", () => {
    const calls = [call("t", {}), call("t", {})];
    assert.equal(judge(calls, 2, 2).level, "hard");
    assert.equal(judge(calls, 2, 4).level, "soft");
    assert.deepEqual(judge([]), { level: "none", count: 0 });
  });

  test("a rerun that differs only in duration is the same result", () => {
    const run = (ms: number) => call("run_command", { command: "make" }, `{"exit_code": 1, "duration_ms": ${ms}, "stdout": "broken"}`, "command");
    assert.equal(judge([run(51), run(61), run(55)]).level, "soft");
  });

  test("F2: an observer's repeats stop counting when the workspace changed in between", () => {
    const read = (state: string) => call("read_file", { path: "a" }, "same", "observer", state);
    const edit = (state: string) => call("write_file", { path: "b" }, `w${state}`, "command", state);
    const edited: CallRecord[] = [];
    for (let i = 0; i < 8; i++) edited.push(edit(`s${i}`), read(`s${i + 1}`));
    assert.equal(judge(edited).level, "none");
    assert.equal(judge(Array.from({ length: 5 }, () => read("s0"))).level, "hard");
  });

  test("F2: a failing command re-run between edits with identical output is a loop at the command threshold (10)", () => {
    const run = () => call("run_command", { command: "make" }, "boom", "command", "x");
    const edit = (i: number) => call("write_file", { path: "b" }, `w${i}`, "command", `s${i}`);
    const calls: CallRecord[] = [];
    for (let i = 0; i < 9; i++) calls.push(run(), edit(i));
    assert.equal(judge([...calls, run()]).level, "hard");
    assert.equal(judge(calls.slice(0, -1).concat(call("run_command", { command: "make" }, "other", "command"))).level, "none");
  });

  test("F1: polls have four times the observer's hard threshold; the note still comes at the soft one", () => {
    const poll = () => call("run_command", { command: "tail log" }, "ok", "poll");
    assert.equal(judge(Array.from({ length: 5 }, poll)).level, "soft");
    assert.equal(judge(Array.from({ length: 19 }, poll)).level, "soft");
    assert.equal(judge(Array.from({ length: 20 }, poll)).level, "hard");
  });

  test("F3: an unknown workspace identity never reaches the hard threshold", () => {
    const read = () => call("read_file", { path: "a" }, "same", "observer", "unknown");
    const v = judge(Array.from({ length: 7 }, read));
    assert.equal(v.level, "soft");
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

describe("CS-3 resolveRepeatedCallSettings", () => {
  test("defaults, operator values, and rejected values with warnings", () => {
    assert.deepEqual(resolveRepeatedCallSettings({}), { soft: 3, hard: 5, warnings: [] });
    assert.deepEqual(resolveRepeatedCallSettings({ soft: "4", hard: "9" }), { soft: 4, hard: 9, warnings: [] });
    for (const bad of [{ soft: "0" }, { soft: "1" }, { soft: "2.5" }, { soft: "abc" }, { hard: "0" }, { hard: "3" }]) {
      const r = resolveRepeatedCallSettings(bad);
      assert.equal(r.soft, 3);
      assert.equal(r.hard, 5);
      assert.equal(r.warnings.length, 1);
    }
    assert.equal(resolveRepeatedCallSettings({ soft: "6" }).hard, 7, "hard stays above soft");
  });

  test("a project .env can only lower the thresholds", () => {
    assert.equal(resolveRepeatedCallSettings({}, { hard: "1000000" }).hard, 5);
    assert.equal(resolveRepeatedCallSettings({ hard: "9" }, { hard: "1000000" }).hard, 9);
    assert.equal(resolveRepeatedCallSettings({ hard: "9" }, { hard: "6" }).hard, 6);
    assert.equal(resolveRepeatedCallSettings({}, { soft: "9" }).soft, 3);
    assert.deepEqual(resolveRepeatedCallSettings({}, { soft: "1" }).warnings.length, 1);
    const r = resolveRepeatedCallSettings({}, { soft: "2", hard: "3" });
    assert.deepEqual([r.soft, r.hard], [2, 3]);
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
const cfg = (endpoint: string, workspace: string, repeatedCalls?: { soft: number; hard: number }): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
  ...(repeatedCalls ? { repeatedCalls } : {}),
});
const read: Reply = { kind: "tools", calls: [{ name: "read_file", args: { path: "a.txt" } }] };
const script = (...replies: Reply[]) => (n: number): Reply => replies[n - 1] ?? { kind: "text", content: "finished" };
const write = (content: string, path = "a.txt"): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path, content, overwrite: true } }] });
const failing: Reply = { kind: "tools", calls: [{ name: "run_command", args: { command: "echo broken; exit 1" } }] };
const poll: Reply = { kind: "tools", calls: [{ name: "run_command", args: { command: "echo still building" } }] };
const noContinuation = (c: HarnessConfig): HarnessConfig => ({ ...c, continuation: undefined });
const said = (agent: AutonomousAgent, n: number) => (agent as any).messages.filter((m: any) => typeof m.content === "string" && m.content.includes(`with the same arguments ${n} times and got`)).length;

async function withAgent(config: (url: string, repo: string) => HarnessConfig, files: Record<string, string>, replies: Reply[], body: (agent: AutonomousAgent, gw: Awaited<ReturnType<typeof startGateway>>) => Promise<void>) {
  const repo = makeRepo(files);
  const gw = await startGateway(script(...replies));
  const agent = quiet(new AutonomousAgent(config(gw.url, repo)));
  try {
    await body(agent, gw);
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("CS-3 at the agent layer", () => {
  test("five identical read_file calls without continuation: a note at 3, BLOCKED TOOL_CALL_LOOP at 5 with history (F5)", { timeout: 90_000 }, async () => {
    await withAgent((u, r) => noContinuation(cfg(u, r)), { "a.txt": "hello\n" }, [read, read, read, read, read, read, read], async (agent, gw) => {
      const turn = await agent.runTurn("Read a.txt.");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.tool, "read_file");
      assert.equal(turn.repeatedCall?.count, 5);
      assert.deepEqual(turn.repeatedCall?.history, [{ tool: "read_file", arguments: '{"path":"a.txt"}', count: 5 }]);
      assert.equal(gw.requests.length, 5, "no request after the fifth call");
      assert.equal(said(agent, 3), 1);
      assert.equal(said(agent, 4), 0);
    });
  });

  test("F2: edits between identical reads are progress, not a loop", { timeout: 90_000 }, async () => {
    const replies: Reply[] = [];
    for (let i = 0; i < 7; i++) replies.push({ kind: "tools", calls: [{ name: "read_file", args: { path: "a.txt" } }] }, write(`${i}\n`, "b.txt"));
    await withAgent((u, r) => cfg(u, r), { "a.txt": "hello\n", "b.txt": "0\n" }, replies, async (agent, gw) => {
      const turn = await agent.runTurn("Iterate.");
      assert.notEqual(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall, undefined);
      assert.ok(gw.requests.length >= 15);
    });
  });

  test("a failing command repeated ten times between edits is stopped; the tracker alone would not", { timeout: 120_000 }, async () => {
    const replies: Reply[] = [];
    for (let i = 1; i <= 10; i++) replies.push(failing, write(`${i}\n`));
    await withAgent((u, r) => cfg(u, r), { "a.txt": "0\n" }, replies, async (agent, gw) => {
      const turn = await agent.runTurn("Fix it.");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.tool, "run_command");
      assert.equal(turn.repeatedCall?.count, 10);
      assert.equal(gw.requests.length, 19);
    });
  });

  test("F1: five identical external polls with unchanged output do not stop the turn", { timeout: 120_000 }, async () => {
    await withAgent((u, r) => cfg(u, r), {}, [poll, poll, poll, poll, poll, poll, { kind: "text", content: "build finished" }], async (agent, gw) => {
      const turn = await agent.runTurn("Wait for the build.");
      assert.notEqual(turn.reason, "TOOL_CALL_LOOP");
      assert.notEqual(turn.execution, "BLOCKED");
      assert.equal(gw.requests.length, 7);
    });
  });

  test("identical arguments with a changing result are not stopped", { timeout: 90_000 }, async () => {
    const bump: Reply = { kind: "tools", calls: [{ name: "run_command", args: { command: "head -c 6 /dev/urandom | base64" } }] };
    await withAgent((u, r) => noContinuation(cfg(u, r)), {}, [bump, bump, bump, bump, bump, bump, bump, { kind: "text", content: "all done" }], async (agent, gw) => {
      const turn = await agent.runTurn("Sample.");
      assert.notEqual(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall, undefined);
      assert.equal(gw.requests.length, 8);
    });
  });

  test("F3: with the workspace state unknown, five identical reads only get the note", { timeout: 90_000 }, async () => {
    await withAgent((u, r) => noContinuation(cfg(u, r)), { "a.txt": "hello\n" }, [read, read, read, read, read, read, { kind: "text", content: "done" }], async (agent, gw) => {
      (agent as any).workspaceStateIdentity = () => "unknown";
      const turn = await agent.runTurn("Read a.txt.");
      assert.notEqual(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(gw.requests.length, 7);
      assert.equal(said(agent, 3), 1);
    });
  });

  test("F5: thresholds come from config.repeatedCalls even without continuation", { timeout: 90_000 }, async () => {
    await withAgent((u, r) => noContinuation(cfg(u, r, { soft: 2, hard: 3 })), { "a.txt": "hello\n" }, [read, read, read, read], async (agent, gw) => {
      const turn = await agent.runTurn("Read a.txt.");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(turn.repeatedCall?.count, 3);
      assert.equal(gw.requests.length, 3);
    });
  });

  test("F7: no second note when the tracker's recovery note is delivered in the same step", { timeout: 90_000 }, async () => {
    await withAgent((u, r) => cfg(u, r), { "a.txt": "hello\n" }, [read, read, read, { kind: "text", content: "done" }], async (agent) => {
      await agent.runTurn("Read a.txt.");
      assert.equal(said(agent, 3), 0);
      assert.equal((agent as any).messages.filter((m: any) => typeof m.content === "string" && m.content.includes("Nexus recovery 1/")).length, 1);
    });
  });
});
