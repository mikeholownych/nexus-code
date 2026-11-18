/**
 * CS-11: OpenHands' stuck-detector patterns replayed as scripted transcripts against the real agent turn.
 * Each ends BLOCKED, recovered (a Nexus note reached the model and the turn then finished), or is recorded with the
 * reason the existing guard already stops it.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./helpers/leak_guard.js";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";

const cfg = (endpoint: string, workspace: string, continuation = true): HarnessConfig => ({
  endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true,
  ...(continuation ? { continuation: { ...DEFAULT_CONTINUATION } } : {}),
});
const tool = (name: string, args: unknown): Reply => ({ kind: "tools", calls: [{ name, args }] });
const text = (content: string): Reply => ({ kind: "text", content });
const notes = (agent: AutonomousAgent, needle: string): number =>
  (agent as any).messages.filter((m: any) => typeof m.content === "string" && m.content.includes(needle)).length;

async function withAgent(continuation: boolean, files: Record<string, string>, replies: Reply[], body: (agent: AutonomousAgent, gw: Awaited<ReturnType<typeof startGateway>>) => Promise<void>) {
  const repo = makeRepo(files);
  const gw = await startGateway((n) => replies[n - 1] ?? text("finished"));
  const agent = new AutonomousAgent(cfg(gw.url, repo, continuation));
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  try { await body(agent, gw); } finally { agent.shutdown(); await gw.close(); fs.rmSync(repo, { recursive: true, force: true }); }
}

/** A stale harness-core (version mismatch) fails every run_command identically, which would make "changing text" untestable. */
const engineUnusable = (agent: AutonomousAgent): boolean =>
  (agent as any).messages.some((m: any) => typeof m.content === "string" && m.content.includes("Engine version mismatch"));
const sameNotes = (agent: AutonomousAgent) => notes(agent, "with the same arguments");
const recoveryNotes = (agent: AutonomousAgent) => notes(agent, "Nexus recovery");

const read = tool("read_file", { path: "a.txt" });
const readB = tool("read_file", { path: "b.txt" });
const failing = tool("run_command", { command: "echo broken; exit 1" });
// The text changes on every call, deterministically: a counter file, never the clock. The counter lives outside the workspace
// so the command does not change the workspace state (a mutated workspace would make each call a new state, not a repeat).
const counterDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-loop-counter-"));
let counterSeq = 0;
after(() => fs.rmSync(counterDir, { recursive: true, force: true }));
const counterCmd = (body: string): Reply => {
  const f = path.join(counterDir, `c${++counterSeq}`);
  return tool("run_command", { command: `f=${f}; n=$(cat $f 2>/dev/null || echo 0); n=$((n+1)); echo $n > $f; ${body}; exit 1` });
};
const failingChanging = (): Reply => counterCmd("echo \"broken attempt $n\"");
// The failure itself changes on every call (six different errors, picked by the counter): genuine progress, never a loop.
const failingDifferent = (): Reply => counterCmd("case $n in 1) m='cannot find module alpha';; 2) m='syntax error: unexpected token }';; 3) m='permission denied: /etc/hosts';; 4) m='type mismatch: string vs number';; 5) m='database schema is locked';; *) m='out of disk space';; esac; echo \"$m\"");
const cmdA = tool("run_command", { command: "echo A; exit 1" });
const cmdB = tool("run_command", { command: "echo B; exit 1" });
const sixTimes = (r: Reply): Reply[] => [r, r, r, r, r, r, text("done")];
const pingPong = (a: Reply, b: Reply): Reply[] => [a, b, a, b, a, b, a, b, a, b, a, b, text("done")];

/*
 * Default configuration (continuation on): the non-progress tracker watches every turn, so each pattern is stopped or
 * recovered long before the step limit. Pattern 3 cannot occur inside a turn: a text-only reply ends it.
 */
describe("CS-11 with continuation (the default)", () => {
  test("1. the same action and result 4 times: a recovery note at the third, then the model finishes", { timeout: 90_000 }, async () => {
    await withAgent(true, { "a.txt": "hello\n" }, [read, read, read, read, text("done")], async (agent, gw) => {
      const turn = await agent.runTurn("Read a.txt.");
      assert.equal(turn.execution, "COMPLETED");
      assert.ok(recoveryNotes(agent) >= 1, "a recovery note reached the model");
      assert.equal(gw.requests.length, 5);
    });
  });

  for (const [label, replies] of [
    ["2a. the same command erroring identically", [failing, failing, failing, failing, failing, text("done")]],
    ["4a. an A/B observer ping-pong for 6 cycles", pingPong(read, readB)],
    ["4b. an A/B command ping-pong for 6 cycles", pingPong(cmdA, cmdB)],
  ] as const) {
    test(`${label}: ends LIMIT_REACHED / STAGNATION_DETECTED with notes delivered, well before the replies run out`, { timeout: 120_000 }, async () => {
      await withAgent(true, { "a.txt": "a\n", "b.txt": "b\n" }, [...replies], async (agent, gw) => {
        const turn = await agent.runTurn("Fix it.");
        assert.equal(turn.execution, "LIMIT_REACHED");
        assert.equal(turn.reason, "STAGNATION_DETECTED");
        assert.ok(recoveryNotes(agent) >= 1);
        assert.ok(gw.requests.length < replies.length, `stopped after ${gw.requests.length} of ${replies.length} replies`);
      });
    });
  }

  test("2b. the same command erroring with only a counter changing: noted, then stopped (CS-11 gap closed)", { timeout: 120_000 }, async (t) => {
    const replies = sixTimes(failingChanging());
    await withAgent(true, { "a.txt": "x\n" }, replies, async (agent, gw) => {
      const turn = await agent.runTurn("Fix it.");
      if (engineUnusable(agent)) return t.skip("harness-core is stale: run_command cannot produce changing output here");
      // The counter ("broken attempt N") is volatile text: the failure is the same, so the tracker sees a repeat.
      assert.equal(turn.execution, "LIMIT_REACHED");
      assert.equal(turn.reason, "STAGNATION_DETECTED");
      assert.ok(recoveryNotes(agent) >= 1, "a recovery note reached the model before the stop");
      assert.ok(gw.requests.length < replies.length, `stopped after ${gw.requests.length} of ${replies.length} replies`);
    });
  });

  test("2c. the same command failing with a genuinely different error each time: NOT stopped", { timeout: 120_000 }, async (t) => {
    const replies = sixTimes(failingDifferent());
    await withAgent(true, { "a.txt": "x\n" }, replies, async (agent, gw) => {
      const turn = await agent.runTurn("Fix it.");
      if (engineUnusable(agent)) return t.skip("harness-core is stale: run_command cannot produce changing output here");
      // Each failure is a new one, so each is progress: no note, no stop, every scripted reply consumed.
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(recoveryNotes(agent), 0);
      assert.equal(sameNotes(agent), 0);
      assert.equal(gw.requests.length, 7, "every scripted reply was consumed");
    });
  });

  test("3. consecutive messages without progress cannot build up: a text-only reply ends the turn and returns control to the operator", { timeout: 90_000 }, async () => {
    await withAgent(true, { "a.txt": "x\n" }, [text("I will look into it."), text("Still looking."), text("Thinking.")], async (agent, gw) => {
      const turn = await agent.runTurn("Fix the bug in a.txt.");
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(gw.requests.length, 1);
    });
  });
});

/*
 * With --no-continuation only CS-3 runs. Identical repeats are noted at 3 and stopped at the call class's hard
 * threshold (observer 5, command 10). A result that changes in more than volatile text is progress by design (2c).
 */
describe("CS-11 without continuation (CS-3 alone)", () => {
  test("1. the same read and result 4 times: one note at the third repeat, no stop", { timeout: 90_000 }, async () => {
    await withAgent(false, { "a.txt": "hello\n" }, [read, read, read, read, text("done")], async (agent) => {
      const turn = await agent.runTurn("Read a.txt.");
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(sameNotes(agent), 1);
    });
  });

  test("2a. the same command erroring identically 5 times: noted at 3; the stop is deliberately at 10 for commands", { timeout: 90_000 }, async () => {
    await withAgent(false, { "a.txt": "x\n" }, [failing, failing, failing, failing, failing, text("done")], async (agent) => {
      const turn = await agent.runTurn("Fix it.");
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(sameNotes(agent), 1);
    });
  });

  test("2b. the same command erroring with only a counter changing is the same failure to CS-3: noted at the third repeat, no stop", { timeout: 90_000 }, async (t) => {
    await withAgent(false, { "a.txt": "x\n" }, sixTimes(failingChanging()), async (agent) => {
      const turn = await agent.runTurn("Fix it.");
      if (engineUnusable(agent)) return t.skip("harness-core is stale: run_command cannot produce changing output here");
      assert.equal(turn.execution, "COMPLETED");
      assert.ok(sameNotes(agent) >= 1);
    });
  });

  test("2c. a genuinely different error each time is progress to CS-3: no note, no stop", { timeout: 90_000 }, async (t) => {
    await withAgent(false, { "a.txt": "x\n" }, sixTimes(failingDifferent()), async (agent) => {
      const turn = await agent.runTurn("Fix it.");
      if (engineUnusable(agent)) return t.skip("harness-core is stale: run_command cannot produce changing output here");
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(sameNotes(agent), 0);
    });
  });

  test("4a. an A/B observer ping-pong: BLOCKED TOOL_CALL_LOOP in the fifth cycle", { timeout: 90_000 }, async () => {
    await withAgent(false, { "a.txt": "a\n", "b.txt": "b\n" }, pingPong(read, readB), async (agent, gw) => {
      const turn = await agent.runTurn("Compare.");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.reason, "TOOL_CALL_LOOP");
      assert.equal(gw.requests.length, 9);
      assert.equal(sameNotes(agent), 2);
    });
  });

  test("4b. an A/B command ping-pong for 6 cycles: both calls noted at 3; the stop is deliberately at 10 each", { timeout: 120_000 }, async () => {
    await withAgent(false, { "a.txt": "a\n" }, pingPong(cmdA, cmdB), async (agent) => {
      const turn = await agent.runTurn("Fix.");
      assert.equal(turn.execution, "COMPLETED");
      assert.equal(sameNotes(agent), 2);
    });
  });
});
