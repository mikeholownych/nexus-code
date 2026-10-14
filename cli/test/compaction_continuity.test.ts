/**
 * Compaction and task continuity: no step ceiling on progressing work, state-aware repetition, objective-scoped tracking
 * that survives follow-ups, compaction and restart, a durable compaction boundary with queued operator /compact, and
 * optional provider capabilities with truthful token accounting. Every scenario runs the real agent loop against a
 * deterministic local gateway (scripted fixtures establish behaviour under those fixtures, not local-model quality).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { continuationBudget } from "../src/config.js";
import { SessionManager } from "../src/session.js";
import { startGateway, makeRepo, Reply, waitUntil } from "./helpers/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cc-home-"));
  process.env.HOME = home;
});
after(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string, o: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  continuation: { ...DEFAULT_CONTINUATION },
  ...o,
});
const write = (name: string, content = `${name}\n`): Reply => ({ kind: "tools", calls: [{ name: "write_file", args: { path: name, content } }] });
const read = (name: string): Reply => ({ kind: "tools", calls: [{ name: "read_file", args: { path: name } }] });
const run = (command: string): Reply => ({ kind: "tools", calls: [{ name: "run_command", args: { command } }] });
const text = (content: string): Reply => ({ kind: "text", content });
const allText = (body: any) => (body.messages as any[]).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
async function phase(agent: AutonomousAgent, wanted: string, timeoutMs = 20_000): Promise<void> {
  await waitUntil(() => agent.getTurnLifecycle()?.phase === wanted, timeoutMs);
}

describe("A. progressing work has no step ceiling", () => {
  test("the default continuation budget sets no step or time limit; explicit operator limits still apply", () => {
    const saved = { s: process.env.NEXUS_MAX_TOTAL_STEPS, m: process.env.NEXUS_MAX_TURN_MINUTES };
    delete process.env.NEXUS_MAX_TOTAL_STEPS;
    delete process.env.NEXUS_MAX_TURN_MINUTES;
    try {
      const b = continuationBudget({})!;
      assert.equal(b.maxTotalSteps, Number.POSITIVE_INFINITY);
      assert.equal(b.maxTurnMinutes, Number.POSITIVE_INFINITY);
      assert.equal(continuationBudget({ maxTotalSteps: "40" })!.maxTotalSteps, 40);
      assert.equal(continuationBudget({ maxTurnMinutes: "5" })!.maxTurnMinutes, 5);
    } finally {
      if (saved.s !== undefined) process.env.NEXUS_MAX_TOTAL_STEPS = saved.s;
      if (saved.m !== undefined) process.env.NEXUS_MAX_TURN_MINUTES = saved.m;
    }
  });

  test("a progressing objective runs beyond 300 steps with no forced termination and no step-exhaustion prompt", { timeout: 900_000 }, async () => {
    const STEPS = 310;
    const repo = makeRepo();
    // Driven by the workspace, not the request count: compaction's findings requests (no tools) also reach the gateway.
    const written = () => (fs.existsSync(path.join(repo, "d")) ? fs.readdirSync(path.join(repo, "d")).length : 0);
    const gw = await startGateway((_n, body) => (!body?.tools ? text("No findings to record.") : written() < STEPS ? write(`d/f${written() + 1}.txt`) : text("All files written.")));
    // A 30k window so the run crosses compaction boundaries on the way.
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 30_000 })));
    try {
      const turn = await agent.runTurn("Write files d/f1.txt through d/f310.txt, one per step.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify({ reason: turn.reason, detail: turn.detail }));
      assert.equal(turn.steps.used, STEPS + 1);
      assert.equal(turn.steps.limitReached, false);
      assert.ok(fs.existsSync(path.join(repo, "d", `f${STEPS}.txt`)));
      for (const body of (gw.requests as any[]).filter((b) => b.tools)) {
        const t = allText(body);
        assert.doesNotMatch(t, /steps? remains?|Finish now|step \d+ of \d+|step limit/i, "no step-exhaustion prompt");
      }
      const tracking = agent.getObjective()!.execution!;
      assert.equal(tracking.cumulativeSteps, STEPS + 1);
      assert.ok(turn.continuation!.segments >= 11, "segments are checkpoints, not limits");
      assert.equal(turn.continuation!.cumulativeSteps, STEPS + 1);
      assert.ok(tracking.compactions.filter((c) => c.committed).length >= 1, "the long run crossed at least one compaction boundary");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a delegated helper has no step allowance: it runs past 15 steps while it progresses", { timeout: 120_000 }, async () => {
    const gw = await startGateway((n, body) => {
      const sub = allText(body).includes("[Subagent Objective]");
      if (!sub) return n === 1 ? { kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt: "write s1..s20", max_steps: 2 } }] } : text("parent done");
      const written = (body.messages as any[]).filter((m) => m.role === "tool").length;
      return written < 20 ? write(`s/s${written + 1}.txt`) : { kind: "tools", calls: [{ name: "task_completed", args: { summary: "wrote 20 files" } }] };
    });
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Delegate writing s1..s20 to a helper.");
      assert.ok(fs.existsSync(path.join(repo, "s", "s20.txt")), "the helper was not cut off by a step allowance");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("B. repetition is judged against workspace state", () => {
  test("an unchanged failing command repeated on an unchanged workspace gets a recovery note; after an input change the retry is legitimate", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "check.sh": "grep -q fixed input.txt || { echo 'FAIL: input not fixed'; exit 1; }\n", "input.txt": "broken\n" });
    const script = (n: number): Reply => {
      if (n <= 2) return run("sh check.sh"); // twice: a legitimate re-check, below the threshold
      if (n === 3) return run("printf 'still broken\\n' > input.txt"); // a real input change
      if (n <= 5) return run("sh check.sh"); // same command and same output, but on a new state: not a loop
      if (n === 6) return run("sh check.sh"); // third on that state: a loop
      return text("stopping");
    };
    const gw = await startGateway(script);
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxRecoveries: 2 } })));
    agent.backoffSleep = async () => {};
    try {
      await agent.runTurn("Make check.sh pass.");
      const notesAt = (gw.requests as any[]).map((b, i) => [i + 1, (b.messages as any[]).filter((m) => m.role === "user" && String(m.content).startsWith("[Nexus recovery")).length] as const);
      const firstNote = notesAt.find(([, c]) => c > 0)?.[0];
      assert.equal(firstNote, 7, `no note for the retries after the edit; the first note follows the third run on the edited state (${JSON.stringify(notesAt)})`);
      const loops = agent.getObjective()!.execution!.repetitions.filter((r) => r.count >= 3);
      assert.equal(loops.length, 1);
      assert.match(loops[0].action, /sh check\.sh/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an unchanged poll waits with backoff instead of counting as a loop; changing timestamps in its output are not progress", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    let clock = 0;
    const gw = await startGateway((n) => (n <= 5 ? run(`echo "status pending at $(date -u +%H:%M:%S.%N)"`) : text("still pending; stopping")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 50 } })));
    const waits: number[] = [];
    agent.backoffSleep = async (ms) => {
      waits.push(ms);
      clock += ms;
    };
    try {
      const turn = await agent.runTurn("Wait for the status to change.");
      assert.notEqual(turn.reason, "STAGNATION_DETECTED", "polling is not a loop");
      assert.deepEqual(waits, [1000, 2000, 4000, 8000], "doubling backoff before each unchanged re-check");
      const t = agent.getObjective()!.execution!;
      assert.equal(t.stepsWithoutProgress, 4, "only the first poll was new information; the four later ones differ only in their timestamp");
      assert.ok(t.interventions.some((i) => i.kind === "backoff"));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rewriting identical content is not progress: the turn stops on stagnation", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => write("same.txt", "unchanging\n"));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 6, maxRecoveries: 10 } })));
    try {
      const turn = await agent.runTurn("Write same.txt.");
      assert.equal(turn.reason, "STAGNATION_DETECTED");
      assert.ok(gw.requests.length <= 8, `bounded: ${gw.requests.length}`);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("re-reading what compaction removed is not task repetition; recurring re-reads are reported as context thrash", { timeout: 120_000 }, async () => {
    // Live finding (2026-10-13, engineering/b0, 24k window): the model re-read files whose output compaction had cut,
    // and the re-reads were stopped as a repeated action. A re-read after removal re-acquires; it is not a loop.
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");
    const repo = makeRepo({ "big.txt": `${big}\n` });
    const gw = await startGateway((n) => (n <= 5 ? read("big.txt") : text("done reading")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 16_000, completionReserveTokens: 1_000, toolResponseReserveTokens: 1_000, continuation: { ...DEFAULT_CONTINUATION, maxRecoveries: 2 } })));
    try {
      const turn = await agent.runTurn("Read big.txt and report its last line.");
      assert.notEqual(turn.detail ?? "", "", "the turn has a stated outcome");
      assert.doesNotMatch(turn.detail ?? "", /repeated read_file .* after 2 recovery notes/, "re-acquisition is not stopped as a repeated action");
      const t = agent.getObjective()!.execution!;
      assert.ok(t.repetitions.some((r) => (r.reacquired ?? 0) >= 1), JSON.stringify(t.repetitions.map((r) => [r.action, r.count, r.reacquired])));
      assert.ok(t.stagnation.some((e) => e.kind === "context_thrash"), "recurring re-acquisition is recorded as context thrash");
      assert.ok(!t.stagnation.some((e) => e.kind === "repetition"), "and not as task repetition");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a workspace whose state cannot be established reports that instead of asserting it unchanged", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 4 ? read("base.txt") : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    (agent as any).workspaceStateIdentity = function () {
      this.stateIdentityUncertainty = "the workspace state could not be established (simulated)";
      return "unknown";
    };
    try {
      const turn = await agent.runTurn("Look at base.txt.");
      assert.notEqual(turn.reason, "STAGNATION_DETECTED", "no loop is asserted on an unknown state");
      assert.match(turn.continuation?.stateUncertainty ?? "", /could not be established/);
      assert.ok(agent.getObjective()!.execution!.stagnation.some((e) => e.kind === "repetition_state_unknown"));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("tracking survives follow-up turns, compaction and restart", () => {
  test("'continue' keeps the objective, its constraints and its tracking; a new request starts new tracking", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    let phaseNo = 1;
    const gw = await startGateway(() => (phaseNo === 1 ? read("base.txt") : phaseNo === 2 ? read("base.txt") : text("ok")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, maxRecoveries: 1 } })));
    try {
      const first = await agent.runTurn("Inspect base.txt. Constraint: never modify base.txt.");
      assert.equal(first.reason, "STAGNATION_DETECTED");
      const ledger = agent.getObjective()!;
      const stepsAfterFirst = ledger.execution!.cumulativeSteps;
      phaseNo = 2;
      await agent.runTurn("continue");
      assert.equal(agent.getObjective(), ledger, "the same objective");
      assert.equal(ledger.execution!.turns, 2);
      assert.ok(ledger.execution!.cumulativeSteps > stepsAfterFirst, "cumulative steps continue");
      assert.ok(ledger.execution!.repetitions.find((r) => r.action.includes("base.txt"))!.count > 3, "the repetition count carried over");
      assert.ok(ledger.amendments.some((a) => a.text === "continue"));
      assert.match(ledger.objective, /never modify base\.txt/, "the original constraint is kept verbatim");
      phaseNo = 3;
      await agent.runTurn("Now summarize the README instead.");
      assert.notEqual(agent.getObjective(), ledger, "a genuinely new request is a new objective");
      assert.equal(agent.getObjective()!.execution!.turns, 1);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("manual compaction keeps tracking and the pinned objective; a restart restores both, and the archive, from the session", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    let reply: (n: number) => Reply = (n) => (n <= 6 ? write(`w${n}.txt`) : text("paused"));
    const gw = await startGateway((n) => reply(n));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    let current: AutonomousAgent = agent;
    const sessions = new SessionManager(path.join(home, "sessions-restart"), () => current.getWorkspacePathIdentity());
    const sessionId = sessions.generateSessionId();
    const save = () =>
      sessions.saveSession({ id: sessionId, workspace: repo, model: "m", messages: agent.getMessages(), objective: agent.getObjective() ?? null, findings: agent.getFindings(), history: agent.getHistoryCompleteness() }, agent.getWorkspacePathIdentity());
    agent.setArchiveSink((id, messages) => sessions.appendArchivedHistory(sessionId, messages, id));
    agent.setProgressListener(save);
    let restored: AutonomousAgent | undefined;
    try {
      await agent.runTurn("1. Write w1..w6\n2. Keep every file under 10 bytes");
      const before = structuredClone(agent.getObjective()!.execution!);
      const result = await agent.compactNow(false);
      assert.equal(result.ok, true, result.message);
      assert.equal(result.durable, true, result.message);
      assert.match(result.message, /archive, task state and session written/);
      const after = agent.getObjective()!.execution!;
      assert.equal(after.cumulativeSteps, before.cumulativeSteps);
      assert.deepEqual(after.repetitions, before.repetitions);
      assert.equal(after.compactions.at(-1)?.trigger, "manual");
      const pinned = (agent as any).requestMessages(agent.getMessages()).map((m: any) => String(m.content)).join("\n");
      assert.match(pinned, /Keep every file under 10 bytes/, "the operator's constraint is still in what the model sees");

      // Restart: a new process resumes from the session record and its archive.
      agent.setProgressListener(undefined);
      const saved = sessions.loadSession(sessionId)!;
      restored = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      current = restored;
      const notice = restored.restoreConversation(saved, (committed) => sessions.readArchivedHistory(sessionId, committed));
      assert.equal(notice, undefined, "the archive is whole");
      assert.deepEqual(restored.getObjective()!.execution!.cumulativeSteps, after.cumulativeSteps);
      assert.equal(restored.getHistoryCompleteness().complete, false, "a resumed compacted conversation is not reported complete");
      assert.equal(restored.getHistoryCompleteness().compactions, agent.getHistoryCompleteness().compactions);
      assert.ok(((restored as any).archiveForReading as any[]).length > 0, "read_archive still finds the originals");
      reply = () => text("resumed");
      await restored.runTurn("continue");
      assert.equal(restored.getObjective()!.execution!.turns, 2, "the resumed objective's tracking continues");
    } finally {
      agent.shutdown();
      restored?.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("C. operator /compact is queued during active work", () => {
  test("during inference: acknowledged, run after that step's tool batch and before the next request, outcome reported", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 4 ? { ...write(`q${n}.txt`), delayMs: n === 4 ? 600 : 0 } : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const outcomes: any[] = [];
    agent.setObserver({ onCompaction: (e) => outcomes.push(e) });
    try {
      const running = agent.runTurn("Write q1..q4.");
      await waitUntil(() => gw.requests.length === 4 && agent.getTurnLifecycle()?.phase === "inference");
      const ack = agent.requestCompaction("r1", false);
      assert.equal(ack.status, "queued");
      assert.equal(agent.requestCompaction("r2", false).status, "duplicate");
      await running;
      assert.equal(outcomes.length, 2, "both requests get the one outcome");
      assert.ok(outcomes.every((o) => o.status === "completed" && o.ok && o.durable), JSON.stringify(outcomes));
      const fourth = gw.requests[3] as any;
      const fifth = gw.requests[4] as any;
      assert.equal((fourth.messages as any[]).filter((m) => m.role === "tool").length, 3, "the in-flight request was not compacted under it");
      assert.ok(fifth.messages.length < fourth.messages.length + 2, "the next request follows the compaction");
      const last = (fifth.messages as any[]).filter((m) => m.role === "assistant").at(-1);
      assert.ok(fifth.messages.some((m: any) => m.role === "tool" && m.tool_call_id === last?.tool_calls?.[0]?.id), "the settled tool result of step 4 precedes the compaction");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("during a tool batch and during an approval: never run until the batch has settled", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? run("sleep 1; echo slept") : n === 2 ? write("approved.txt") : n === 3 ? write("w3.txt") : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const events: string[] = [];
    let releaseApproval!: () => void;
    const approval = new Promise<void>((r) => (releaseApproval = r));
    agent.setObserver({ onCompaction: (e) => events.push(`compaction:${e.id}:${e.status}`), onToolEnd: (e) => events.push(`toolEnd:${e.tool}`) });
    try {
      const running = agent.runTurn("Run, then write two files.", async (tool) => {
        if (tool === "write_file" && !events.includes("approval")) {
          events.push("approval");
          await approval;
        }
        return true;
      });
      await phase(agent, "tool");
      assert.equal(agent.requestCompaction("during-tool", false).status, "queued");
      await waitUntil(() => events.includes("approval"));
      assert.equal(agent.requestCompaction("during-approval", true).status, "queued");
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!events.includes("compaction:during-approval:completed"), "nothing ran while the approval was pending");
      releaseApproval();
      await running;
      const duringTool = events.indexOf("compaction:during-tool:completed");
      const duringApproval = events.indexOf("compaction:during-approval:completed");
      assert.ok(duringTool > events.indexOf("toolEnd:run_command"), `the tool-phase request ran after its batch settled: ${JSON.stringify(events)}`);
      assert.ok(duringTool < events.indexOf("approval"), "and before the next step's inference (whose tool needed the approval)");
      assert.ok(duringApproval > events.indexOf("toolEnd:write_file"), `the approval-phase request ran after the approved batch settled: ${JSON.stringify(events)}`);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a request arriving as the turn finishes runs at its end; a cancelled turn cancels queued requests", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? write("a.txt") : n === 2 ? { ...text("finished"), delayMs: 500 } : { ...write("b.txt"), delayMs: 3000 }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const outcomes: any[] = [];
    agent.setObserver({ onCompaction: (e) => outcomes.push(e) });
    try {
      const running = agent.runTurn("Write a.txt.");
      await waitUntil(() => gw.requests.length === 2);
      assert.equal(agent.requestCompaction("late", false).status, "queued");
      await running;
      assert.deepEqual(outcomes.map((o) => o.status), ["completed"]);

      outcomes.length = 0;
      const second = agent.runTurn("Write b.txt.");
      await waitUntil(() => gw.requests.length === 3);
      agent.requestCompaction("to-cancel", false);
      agent.requestCancel("operator");
      const turn = await second;
      assert.equal(turn.execution, "INTERRUPTED");
      assert.deepEqual(outcomes.map((o) => o.status), ["cancelled"]);
      assert.match(outcomes[0].message, /cancelled/);
      assert.equal(agent.requestCompaction("idle", false).status, "no_active_turn", "outside a turn the host runs /compact directly");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("C. automatic compaction stabilizes instead of thrashing", () => {
  test("after consecutive low-yield pressure compactions, compaction waits until a request would not fit", { timeout: 120_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 12 ? write(`t${n}.txt`) : text("done")));
    // A window where the fixed prompt (~4k) plus reserves is above the 80% pressure mark but admissible: compaction can
    // only remove the few small step messages, so each pressure compaction frees little or nothing.
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 8_000, completionReserveTokens: 1_000, toolResponseReserveTokens: 1_000 })));
    try {
      await agent.runTurn("Write t1..t12.");
      const t = agent.getObjective()!.execution!;
      const committed = t.compactions.filter((c) => c.committed);
      assert.ok(committed.length <= 3, `bounded: ${committed.length} compactions in 13 steps (${JSON.stringify(committed.map((c) => [c.step, c.beforeTokens, c.afterTokens, c.lowYield]))})`);
      assert.ok(t.stagnation.some((e) => e.kind === "compaction_thrash"), "the hold is recorded as thrash evidence, separately from task repetition");
      assert.ok(!t.stagnation.some((e) => e.kind === "repetition"), "thrash is not task repetition");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("C. persistence failures are truthful", () => {
  test("an archive failure leaves the conversation uncompacted and says so", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 3 ? write(`x${n}.txt`) : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Write x1..x3.");
      const before = agent.getMessages().length;
      agent.setArchiveSink(() => {
        throw new Error("ENOSPC: no space left on device");
      });
      const result = await agent.compactNow(false);
      assert.equal(result.ok, false);
      assert.match(result.message, /Not compacted: the originals could not be archived .*ENOSPC/);
      assert.equal(agent.getMessages().length, before);
      assert.equal(agent.getHistoryCompleteness().compactions, 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("task-state and session failures: manual compaction is not reported durable; an automatic one stops the turn", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 3 ? write(`y${n}.txt`) : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Write y1..y3.");
      const manager = (agent as any).stateManager;
      const realSave = manager.saveTaskState.bind(manager);
      manager.saveTaskState = () => {
        throw new Error("EACCES: permission denied");
      };
      agent.setProgressListener(() => {
        throw new Error("session disk full");
      });
      const result = await agent.compactNow(false);
      assert.equal(result.ok, false);
      assert.equal(result.durable, false);
      assert.match(result.message, /applied but not durable: taskState failed: .*EACCES.*; session failed: session disk full/);
      manager.saveTaskState = realSave;
      agent.setProgressListener(undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }

    // Automatic compaction under pressure, with the session record failing: the turn stops before the next request.
    const repo2 = makeRepo();
    const big = "z".repeat(30_000);
    const gw2 = await startGateway((n) => (n <= 6 ? write(`big${n}.txt`, big) : text("done")));
    const agent2 = quiet(new AutonomousAgent(cfg(gw2.url, repo2, { contextLimit: 40_000 })));
    let failSession = false;
    agent2.setProgressListener(() => {
      if (failSession) throw new Error("session disk full");
    });
    try {
      failSession = true;
      const turn = await agent2.runTurn("Write big1..big6.");
      assert.equal(turn.execution, "FAILED", JSON.stringify({ reason: turn.reason, detail: turn.detail }));
      assert.equal(turn.reason, "PERSISTENCE_FAILED");
      assert.match(turn.detail ?? "", /not durable: session failed/);
      assert.ok(turn.persistence?.failures.length, "the result lists the failed writes");
    } finally {
      agent2.shutdown();
      await gw2.close();
      fs.rmSync(repo2, { recursive: true, force: true });
    }
  });

  test("a turn-end state save failure is on the result and is not hidden", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? write("e.txt") : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const notices: string[] = [];
    agent.setObserver({ onNotice: (t) => notices.push(t) });
    const manager = (agent as any).stateManager;
    const realSave = manager.saveTaskState.bind(manager);
    try {
      let calls = 0;
      manager.saveTaskState = (...args: any[]) => {
        calls++;
        if ((args[0] as any).lastTurn) throw new Error("EIO: i/o error");
        return realSave(...args);
      };
      const turn = await agent.runTurn("Write e.txt.");
      assert.ok(calls > 0);
      assert.ok(turn.persistence?.failures.some((f) => /final task state could not be saved: .*EIO/.test(f)), JSON.stringify(turn.persistence));
      assert.ok(notices.some((n) => /EIO/.test(n)));
    } finally {
      manager.saveTaskState = realSave;
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("C. process death around the compaction commit boundary", () => {
  const child = path.join(here, "helpers", "compaction_crash_child.ts");
  const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
  for (const point of ["after_archive", "after_task_state", "mid_archive_line"] as const) {
    test(`death ${point.replace(/_/g, " ")}: the resumed records are consistent and nothing is lost or replayed`, { timeout: 120_000 }, async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-crash-"));
      const r = spawnSync(tsx, [child, work, point], { encoding: "utf8", env: { ...process.env, HOME: work }, timeout: 90_000 });
      // tsx runs the script in a child node process: its SIGKILL reaches us as the wrapper's exit status 137.
      assert.ok(r.signal === "SIGKILL" || r.status === 137, `the child died at ${point}: status ${r.status} signal ${r.signal}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
      const info = JSON.parse(fs.readFileSync(path.join(work, "info.json"), "utf8"));
      const agent = quiet(new AutonomousAgent(cfg("http://127.0.0.1:9/v1", info.repo)));
      const sessions = new SessionManager(path.join(work, "sessions"), () => agent.getWorkspacePathIdentity());
      const saved = sessions.loadSession(info.sessionId)!;
      assert.ok(saved, "the session record is readable");
      try {
        const notice = agent.restoreConversation(saved, (committed) => sessions.readArchivedHistory(info.sessionId, committed));
        const msgs = agent.getMessages().map((m) => String(m.content)).join("\n");
        // The session record was last written before the compaction: it holds every original itself.
        for (const marker of info.markers) assert.match(msgs, new RegExp(marker), `${marker} survives in the resumed conversation`);
        assert.equal(agent.getHistoryCompleteness().compactions, 0, "the session never committed the interrupted compaction");
        if (point === "mid_archive_line") assert.match(notice ?? "", /could not be read \(an interrupted write\)/);
        else assert.match(notice ?? "", /interrupted before it was committed were set aside/);
        // The task state may be newer (after_task_state): it then names the compaction, and its archive lines are there.
        const state = JSON.parse(fs.readFileSync(path.join(work, ".nexus", "tasks", `${info.taskId}.json`), "utf8"));
        const committed: string[] = state.history?.committedCompactions ?? [];
        if (point === "after_task_state") {
          assert.equal(committed.length, 1, "the task state committed the compaction");
          const archive = sessions.readArchivedHistory(info.sessionId, new Set(committed));
          assert.deepEqual(archive.missingCompactions, [], "every compaction a record commits has its originals archived");
        } else {
          assert.equal(committed.length, 0);
        }
        // No action is replayed: the conversation's tool calls all have their recorded results, none marked unknown.
        assert.doesNotMatch(msgs, /No result was recorded for this call/);
      } finally {
        agent.shutdown();
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  }
});

describe("D. optional provider capabilities and truthful token accounting", () => {
  const gatewayEntry = (o: Record<string, any> = {}) => ({
    id: "m",
    context_length: 40_000,
    max_model_len: 40_000,
    max_completion_tokens: 3_000,
    limits_version: "lv-1",
    reasoning: { mode: "off", budget: 0 },
    serving: [{ worker_id: "w1", pool: "lead" }],
    ...o,
  });

  test("standalone: no advertisement and no counting endpoint; Nexus works on labelled defaults and never calls /tokenize", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? write("s.txt") : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Write s.txt.");
      assert.equal(turn.execution, "COMPLETED");
      const acc = turn.tokenAccounting!;
      assert.equal(acc.contextLimit, 65_536);
      assert.equal(acc.contextSource, "client_default");
      assert.equal(acc.tokenCounting, "unsupported");
      assert.equal(acc.lastRequest?.source, "client_estimate");
      assert.match(acc.lastRequest?.uncertainty ?? "", /advertises no request counting/);
      assert.equal(gw.tokenizeRequests.length, 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("advertised capacity and output allowance are used, and a changed capacity takes effect on the next step", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    let entry = gatewayEntry();
    const gw = await startGateway((n) => (n <= 2 ? write(`c${n}.txt`) : text("done")), {
      models: () => [entry],
      tokenize: () => ({ status: 200, body: { model: "m", prompt_tokens: 5000, source: "exact", context_length: entry.context_length, limits_version: entry.limits_version, worker_id: "w1" } }),
      headers: (n) => (n === 1 ? { "X-AIHost-Context-Limit": "30000", "X-AIHost-Prompt-Tokens": "5001", "X-AIHost-Prompt-Tokens-Source": "exact", "X-AIHost-Route": "rule=alias;pool=lead;worker=w1" } : {}),
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 100_000 })));
    const notices: string[] = [];
    agent.setObserver({ onNotice: (t) => notices.push(t) });
    try {
      const firstReq = () => gw.requests[0] as any;
      const running = agent.runTurn("Write c1 and c2.");
      await waitUntil(() => gw.requests.length >= 1);
      assert.equal(firstReq().max_tokens, 3000, "the advertised output allowance is sent");
      assert.equal(agent.getProviderCapabilities()!.contextLimit, 40_000);
      assert.equal(agent.getProviderCapabilities()!.contextSource, "operator_capped_by_advertised", "an operator value above capacity is capped");
      // The gateway reports a different capacity on the admitted request; the catalog changes too.
      entry = gatewayEntry({ context_length: 30_000, max_model_len: 30_000, limits_version: "lv-2" });
      await running;
      assert.equal(agent.getProviderCapabilities()!.contextLimit, 30_000);
      assert.equal(agent.getProviderCapabilities()!.advertised!.limitsVersion, "lv-2");
      assert.ok(notices.some((t) => /Provider limits changed/.test(t) && /30000/.test(t)), notices.join("\n"));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a stale client default never overrides a larger advertised window", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => text("done"), { models: () => [gatewayEntry({ context_length: 131_072, max_model_len: 131_072, max_completion_tokens: 16_384 })] });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Say done.");
      assert.equal(turn.tokenAccounting!.contextLimit, 131_072);
      assert.equal(turn.tokenAccounting!.contextSource, "advertised");
      assert.equal(turn.tokenAccounting!.outputAllowance, 16_384);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("request counting submits the actual outbound request: messages, tools, tool_choice and settings", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n === 1 ? write("t.txt") : text("done")), {
      models: () => [gatewayEntry()],
      tokenize: () => ({ status: 200, body: { prompt_tokens: 4000, source: "exact", worker_id: "w1", limits_version: "lv-1", context_length: 40_000 } }),
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Write t.txt.");
      assert.equal(gw.tokenizeRequests.length, gw.requests.length, "every request was counted before it was sent");
      for (let i = 0; i < gw.requests.length; i++) {
        assert.deepEqual(gw.tokenizeRequests[i], gw.requests[i], `count ${i + 1} is of the exact body inference sent`);
      }
      const counted = gw.tokenizeRequests[0];
      assert.ok(Array.isArray(counted.tools) && counted.tools.length > 5, "tool definitions are counted");
      assert.equal(counted.tool_choice, "auto");
      assert.equal(counted.model, "m");
      assert.ok(typeof counted.max_tokens === "number" && typeof counted.temperature === "number");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an operator limit below advertised capacity is kept, and each request is counted once (not re-counted for the difference)", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway((n) => (n <= 2 ? write(`o${n}.txt`) : text("done")), {
      models: () => [gatewayEntry()],
      tokenize: () => ({ status: 200, body: { prompt_tokens: 4000, source: "exact", worker_id: "w1", context_length: 40_000 } }),
      headers: () => ({ "X-AIHost-Context-Limit": "40000", "X-AIHost-Prompt-Tokens": "4001", "X-AIHost-Prompt-Tokens-Source": "exact", "X-AIHost-Route": "pool=lead;worker=w1" }),
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { contextLimit: 20_000 })));
    try {
      const turn = await agent.runTurn("Write o1 and o2.");
      assert.equal(turn.tokenAccounting!.contextLimit, 20_000);
      assert.equal(turn.tokenAccounting!.contextSource, "operator");
      assert.equal(gw.tokenizeRequests.length, gw.requests.length, "one count per request");
      assert.equal(gw.modelRequests, 1, "no refresh: the worker's capacity matches the advertisement");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("worker, routing and source differences are reported as they are", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => text("done"), {
      models: () => [gatewayEntry({ serving: [{ worker_id: "w1" }, { worker_id: "w2" }] })],
      tokenize: () => ({ status: 200, body: { prompt_tokens: 4100, source: "exact", worker_id: "w1", limits_version: "lv-1", context_length: 40_000 } }),
      headers: () => ({ "X-AIHost-Prompt-Tokens": "4180", "X-AIHost-Prompt-Tokens-Source": "exact", "X-AIHost-Route": "rule=review;pool=deep;worker=w2", "X-AIHost-Context-Limit": "40000", "X-AIHost-Limits-Version": "worker-lv" }),
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Say done.");
      const last = turn.tokenAccounting!.lastRequest!;
      assert.equal(last.source, "exact_sampled_worker", "a pre-dispatch gateway count is exact only for the sampled worker");
      assert.equal(last.countedWorker, "w1");
      assert.equal(last.admittedWorker, "w2");
      assert.equal(last.admittedSource, "exact_admitted");
      assert.equal(last.admittedTokens, 4180);
      assert.equal(last.workerDiffers, true);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  for (const [name, answer, expected] of [
    ["a conservative count", { status: 200, body: { prompt_tokens: 9000, source: "estimated_conservative", worker_id: "w1" } }, { source: "gateway_conservative" }],
    ["unavailable counting (HTTP 503)", { status: 503, body: { error: "busy" } }, { source: "client_estimate", uncertainty: /unavailable: HTTP 503/ }],
    ["a malformed response", { status: 200, body: { prompt_tokens: "many", source: "exact" } }, { source: "client_estimate", uncertainty: /malformed: no numeric prompt_tokens/ }],
    ["an unknown count source", { status: 200, body: { prompt_tokens: 10, source: "magic" } }, { source: "client_estimate", uncertainty: /malformed: unknown count source/ }],
  ] as const) {
    test(`${name} is labelled as what it is and the work continues`, { timeout: 60_000 }, async () => {
      const repo = makeRepo();
      const gw = await startGateway((n) => (n === 1 ? write("u.txt") : text("done")), { models: () => [gatewayEntry()], tokenize: () => answer as any });
      const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      try {
        const turn = await agent.runTurn("Write u.txt.");
        assert.equal(turn.execution, "COMPLETED", "loss of an optional capability is not a product failure");
        const last = turn.tokenAccounting!.lastRequest!;
        assert.equal(last.source, expected.source);
        if ("uncertainty" in expected) {
          assert.match(last.uncertainty ?? "", expected.uncertainty);
          assert.equal(turn.tokenAccounting!.tokenCounting, "unavailable");
        }
      } finally {
        agent.shutdown();
        await gw.close();
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  }

  test("cancellation during counting stops the turn before anything is sent", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const gw = await startGateway(() => text("never"), { models: () => [gatewayEntry()], tokenize: () => ({ status: 200, body: { prompt_tokens: 1, source: "exact" }, delayMs: 3000 }) });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const running = agent.runTurn("Say something.");
      await waitUntil(() => gw.tokenizeRequests.length === 1);
      agent.requestCancel("operator");
      const turn = await running;
      assert.equal(turn.execution, "INTERRUPTED");
      assert.equal(gw.requests.length, 0, "no inference request after a cancelled count");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("credentials and destinations: counting uses the connection's own credential and never a fallback endpoint", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const tok = { status: 200, body: { prompt_tokens: 100, source: "exact", worker_id: "w1" } };
    const gw = await startGateway(() => text("done"), { models: () => [gatewayEntry()], tokenize: () => tok });
    const other = await startGateway(() => text("other"), { models: () => [gatewayEntry()], tokenize: () => tok });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { apiKey: "secret-primary", fallbackEndpoints: [other.url] })));
    try {
      await agent.runTurn("Say done.");
      const tokenizeAuth = gw.authSeen.filter((a) => a.path.endsWith("/tokenize")).map((a) => a.authorization);
      const chatAuth = gw.authSeen.filter((a) => a.path.endsWith("/chat/completions")).map((a) => a.authorization);
      assert.deepEqual([...new Set(tokenizeAuth)], ["Bearer secret-primary"]);
      assert.deepEqual([...new Set(chatAuth)], ["Bearer secret-primary"]);
      assert.equal(other.authSeen.length, 0, "the fallback endpoint saw nothing");
    } finally {
      agent.shutdown();
      await gw.close();
      await other.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a measured count over budget compacts further with calibrated estimates instead of sending", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    // The gateway counts far more than the client estimates (1.5 characters per token).
    const gw = await startGateway((n) => (n <= 6 ? write(`m${n}.txt`, "q".repeat(2000)) : text("done")), {
      models: () => [gatewayEntry({ context_length: 40_000, max_model_len: 40_000 })],
      tokenize: (body) => ({ status: 200, body: { prompt_tokens: Math.ceil(JSON.stringify(body).length / 1.5), source: "exact", worker_id: "w1" } }),
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const turn = await agent.runTurn("Write m1..m6.");
      const counted = gw.tokenizeRequests.length;
      assert.ok(counted >= gw.requests.length, "every sent request was measured");
      assert.ok(["COMPLETED", "BLOCKED"].includes(turn.execution), turn.execution);
      if (turn.execution === "BLOCKED") assert.equal(turn.capacity?.promptCountSource, "exact_sampled_worker", "a refusal names the measured source");
      assert.ok((agent as any).estimateScale > 1, "estimates were calibrated to the measurement");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("strict counting is an explicit opt-in: it refuses an unmeasured request, and proceeds on a measured one", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const plain = await startGateway(() => text("done"));
    const strictAgent = quiet(new AutonomousAgent(cfg(plain.url, repo, { strictTokenCount: true })));
    const measured = await startGateway(() => text("done"), { models: () => [gatewayEntry()], tokenize: () => ({ status: 200, body: { prompt_tokens: 100, source: "exact", worker_id: "w1" } }) });
    const strictMeasured = quiet(new AutonomousAgent(cfg(measured.url, repo, { strictTokenCount: true })));
    try {
      const refused = await strictAgent.runTurn("Say done.");
      assert.equal(refused.execution, "BLOCKED");
      assert.match(refused.capacity?.unmeasured ?? "", /strict counting: the connection advertises no request counting/);
      assert.equal(plain.requests.length, 0, "nothing was sent");
      const ok = await strictMeasured.runTurn("Say done.");
      assert.equal(ok.execution, "COMPLETED");
    } finally {
      strictAgent.shutdown();
      strictMeasured.shutdown();
      await plain.close();
      await measured.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
