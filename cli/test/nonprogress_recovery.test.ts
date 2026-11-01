/**
 * Non-progress recovery at the agent layer (v1.1.2): equivalent observations across read interfaces, escalation from
 * an advisory note to constrained recovery, refusal of redundant observations before they run, recovery continuity
 * across compaction and resume, and bounded termination. Every scenario runs the real agent loop against a
 * deterministic local gateway; execution is asserted from the dispatch path itself (a wrapper around
 * dispatchToolCall records every call that actually ran), never from the model's text.
 *
 * Regression fixture: test/fixtures/nonprogress/incident_20261101_doctor.json, the tool-call sequence of the
 * 2026-11-01 dogfood session that ended "repeated read_file 3 times ... after 2 recovery notes".
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { SessionManager } from "../src/session.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { WorkspacePath } from "../src/core/workspace_path.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/nonprogress/incident_20261101_doctor.json"), "utf8"));

let home = "";
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-np-home-"));
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
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 30, maxRecoveries: 2 },
  ...o,
});
type Call = { name: string; args: unknown };
const tools = (calls: Call[], content?: string): Reply => ({ kind: "tools", calls, ...(content ? { content } : {}) });
const read = (p: string, start?: number, end?: number): Call => ({ name: "read_file", args: { path: p, ...(start ? { start_line: start } : {}), ...(end ? { end_line: end } : {}) } });
const sh = (command: string): Call => ({ name: "run_command", args: { command } });
const text = (content: string): Reply => ({ kind: "text", content });
const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n") + "\n";

/** Records every tool call that actually reached execution (not refused before dispatch). */
function dispatchLog(agent: AutonomousAgent): Array<{ id: string; name: string; args: string }> {
  const log: Array<{ id: string; name: string; args: string }> = [];
  const original = (agent as any).dispatchToolCall.bind(agent);
  (agent as any).dispatchToolCall = async (call: any, ...rest: unknown[]) => {
    log.push({ id: call.id, name: call.function.name, args: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments) });
    return original(call, ...rest);
  };
  return log;
}
const toolMessages = (agent: AutonomousAgent) => agent.getMessages().filter((m: any) => m.role === "tool") as any[];
const refusals = (agent: AutonomousAgent) => toolMessages(agent).filter((m) => String(m.content).startsWith("[Nexus refused: not executed]") && !/the turn stopped before this call/.test(String(m.content)));
const recovery = (agent: AutonomousAgent) => agent.getObjective()!.execution!.recovery;
const kinds = (agent: AutonomousAgent) => recovery(agent).events.map((e: any) => e.kind);
const userTexts = (body: any) => ((body?.messages ?? []) as any[]).filter((m) => m.role === "user").map((m) => String(m.content));
const requestHas = (body: any, re: RegExp) => ((body?.messages ?? []) as any[]).some((m) => re.test(String(m.content)));
/** True when a write_file call for `p` appears among the assistant tool calls the model already issued. */
const wrote = (body: any, p: string) => ((body?.messages ?? []) as any[]).some((m) => m.role === "assistant" && (m.tool_calls ?? []).some((c: any) => c.function?.name === "write_file" && String(c.function?.arguments).includes(JSON.stringify(p))));
/** Ids of tool calls in the assistant messages of the conversation. */
const callIds = (agent: AutonomousAgent, pred: (name: string, args: any) => boolean) =>
  agent.getMessages().flatMap((m: any) => (m.role === "assistant" ? m.tool_calls ?? [] : [])).filter((c: any) => pred(c.function.name, typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments)).map((c: any) => c.id);

describe("regression fixture NONPROGRESS-20261101-DOCTOR", () => {
  test("the incident's tool-call sequence escalates to constrained recovery, refuses the repeats before they run, and stops boundedly", { timeout: 120_000 }, async () => {
    const files = Object.fromEntries(Object.entries(fixture.files as Record<string, { lines: number; prefix: string }>).map(([p, f]) => [p, lines(f.prefix, f.lines)]));
    const repo = makeRepo(files);
    const prelude = fixture.prelude as Array<{ content: string; calls: Call[] }>;
    const gw = await startGateway((n) => {
      if (n <= prelude.length) return tools(prelude[n - 1].calls, prelude[n - 1].content);
      const i = n - prelude.length - 1;
      return tools(fixture.repeat.calls, fixture.repeat.contents[i % fixture.repeat.contents.length]);
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Find and fix a real bug in the doctor command, with a regression test.");
      assert.equal(turn.reason, "STAGNATION_DETECTED", JSON.stringify(turn));
      assert.match(turn.detail ?? "", /recovery exhausted after 2 recovery notes: \d+ equivalent observation\(s\) refused/);
      // State transitions, in order, as recorded in the ledger.
      const k = kinds(agent);
      const order = ["non_progress_detected", "recovery_advisory_issued", "recovery_constrained", "tool_execution_denied", "recovery_exhausted"];
      let at = -1;
      for (const kind of order) {
        const next = k.indexOf(kind, at + 1);
        assert.ok(next > at, `${kind} after ${order[order.indexOf(kind) - 1] ?? "start"}: ${k.join(",")}`);
        at = next;
      }
      assert.ok(k.includes("observation_equivalent"), "lines re-read through different arguments are equivalent");
      // Both notes reached the model, each with at least one inference to respond in.
      const noted = gw.requests.map((body: any, i) => ({ i, notes: userTexts(body).filter((t) => t.startsWith("[Nexus recovery")) }));
      const firstAdvisory = noted.find((r) => r.notes.some((t) => t.startsWith("[Nexus recovery 1/2]")));
      const firstConstrained = noted.find((r) => r.notes.some((t) => t.startsWith("[Nexus recovery 2/2]")));
      assert.ok(firstAdvisory && firstConstrained && firstConstrained.i > firstAdvisory.i, "advisory first, then constrained, in later requests");
      const note2 = firstConstrained!.notes.find((t) => t.startsWith("[Nexus recovery 2/2]"))!;
      for (const section of ["RECOVERY_REQUIRED", "Current objective:", "Previously acquired evidence", "Repeated observations:", "Current workspace state:", "Last meaningful progress:", "Unresolved question:", "Disallowed operations", "Permitted next actions:", "Recovery budget:"]) {
        assert.ok(note2.includes(section), `recovery context has ${section}`);
      }
      assert.match(note2, /cli\/src\/doctor\.ts lines 1-400 of 400/, "evidence is the coverage actually returned");
      assert.match(note2, /is not recorded\. State it in one sentence/, "no unresolved question is invented");
      // Refused calls never reached execution.
      const refusedIds = refusals(agent).map((m) => m.tool_call_id);
      assert.ok(refusedIds.length >= 2, `refusals: ${refusedIds.length}`);
      const ranIds = new Set(ran.map((r) => r.id));
      for (const id of refusedIds) assert.equal(ranIds.has(id), false, `refused call ${id} did not run`);
      // Executions of the repeated pair after constrained recovery began: none.
      const constrainedAtRequest = firstConstrained!.i; // 0-based request index = step - 1
      const repeatIds = new Set(callIds(agent, (name, args) => name === "read_file" && args.path === "cli/src/doctor.ts" && args.end_line === 50));
      const repeatRuns = ran.filter((r) => repeatIds.has(r.id));
      assert.ok(repeatRuns.length <= constrainedAtRequest, "no repeat executed after the constrained note");
      // Bounded: the turn did not run on.
      assert.ok(gw.requests.length <= prelude.length + 6, `bounded: ${gw.requests.length} requests`);
      // The pinned ledger carries the recovery context while constrained (it survives compaction).
      assert.equal(recovery(agent).stage, "constrained");
      const pinned = (agent as any).requestMessages(agent.getMessages()).map((m: any) => String(m.content)).join("\n");
      assert.match(pinned, /RECOVERY_REQUIRED/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("after the constrained note the agent takes another path: the work continues and recovery completes", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 40) });
    const gw = await startGateway((n, body) => {
      if (wrote(body, "fix.txt")) return text("Done: wrote fix.txt using what f.txt already showed.");
      if (requestHas(body, /RECOVERY_REQUIRED/)) return tools([{ name: "write_file", args: { path: "fix.txt", content: "fixed\n" } }]);
      return tools([read("f.txt")]);
    });
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Inspect f.txt and write fix.txt.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.ok(fs.existsSync(path.join(repo, "fix.txt")));
      const k = kinds(agent);
      assert.ok(k.includes("recovery_constrained") && k.includes("recovery_progress_detected") && k.includes("recovery_completed"), k.join(","));
      assert.equal(recovery(agent).stage, "normal");
      assert.equal(refusals(agent).length, 0, "the alternative was taken before any refusal was needed");
      assert.equal(ran.filter((r) => r.name === "read_file").length, 4, "advisory at the 3rd identical read, constrained at the 4th");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("semantic observation identity", () => {
  test("the same lines through read_file, cat, sed and head are equivalent; a constrained shell re-read is refused before it runs", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 30) });
    const script: Call[][] = [[read("f.txt")], [sh("cat f.txt")], [sh("sed -n '1,20p' f.txt")], [sh("head -n 5 f.txt")], [sh("cat ./f.txt")], [read("f.txt", 3, 9)], [sh(`cd ${repo} && head -3 f.txt`)]];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("unreachable")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Look at f.txt.");
      assert.equal(turn.reason, "STAGNATION_DETECTED", JSON.stringify(turn));
      assert.match(turn.detail ?? "", /recovery exhausted/);
      assert.deepEqual(ran.map((r) => JSON.parse(r.args).command ?? JSON.parse(r.args).path), ["f.txt", "cat f.txt", "sed -n '1,20p' f.txt", "head -n 5 f.txt"], "only the first four ran");
      const refused = refusals(agent).map((m) => String(m.content));
      assert.equal(refused.length, 3, "two refusals allowed; the third equivalent attempt is refused and stops the turn");
      assert.match(refused[0], /cat \.\/f\.txt.*already returned on this unchanged workspace.*f\.txt lines 1-30 \(step \d+\)/);
      assert.ok(gw.requests.length <= 7);
      const eq = agent.getObjective()!.execution!.equivalents.find((e: any) => e.path === "f.txt");
      assert.ok(eq && eq.count >= 3, JSON.stringify(eq));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("overlapping but non-identical ranges are new information: no recovery, the task completes", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 100) });
    const script: Call[][] = [[read("f.txt", 1, 50)], [read("f.txt", 40, 90)], [read("f.txt", 85, 100)]];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("f.txt has 100 lines.")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Read f.txt in parts.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.equal(ran.length, 3);
      assert.equal(recovery(agent).episode, 0);
      assert.equal(agent.getObjective()!.execution!.stepsWithoutProgress, 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a narrower re-read of lines already in context is not progress (the stagnation counter is not reset by it)", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 60) });
    const script: Call[][] = [[read("f.txt")], [read("f.txt", 1, 10)]];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("done")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Look at f.txt.");
      const progress = agent.getObjective()!.execution!.progress.map((p: any) => p.step);
      assert.ok(!progress.includes(2), `step 2 (a covered re-read) is not progress: ${progress}`);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a re-read after the file changed is legitimate: never equivalent, never refused", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 10) });
    const script: Call[][] = [
      [read("f.txt")],
      [{ name: "write_file", args: { path: "f.txt", content: "v2\n", overwrite: true } }],
      [read("f.txt")],
      [{ name: "write_file", args: { path: "f.txt", content: "v3\n", overwrite: true } }],
      [read("f.txt")],
      [{ name: "write_file", args: { path: "f.txt", content: "v4\n", overwrite: true } }],
      [sh("cat f.txt")],
    ];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("f.txt now says v4.")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Edit f.txt three times, checking it each time.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.equal(ran.length, 7);
      assert.equal(refusals(agent).length, 0);
      assert.ok(!kinds(agent).includes("observation_equivalent"), kinds(agent).join(","));
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  // Each unsupported form is a distinct action the tracker cannot relate to the lines already read: its first run is
  // new information by action identity and ends the recovery episode (a documented bypass). Repeating the same forms
  // is still detected, and the turn stops on the repeat-offender path.
  test("shell forms outside the recognised set are never refused (documented enforcement boundary), and the turn still stops boundedly", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 20) });
    const unsupported = ["cat f.txt | head -5", "awk 'NR<=5' f.txt", "tail -n 5 f.txt", "cat f.txt base.txt"];
    const gw = await startGateway((n) => (n <= 4 ? tools([read("f.txt")]) : tools([sh(unsupported[(n - 5) % unsupported.length])])));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo, { continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 10, maxRecoveries: 2 } })));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Look at f.txt.");
      assert.equal(turn.reason, "STAGNATION_DETECTED", JSON.stringify(turn));
      const k = kinds(agent);
      assert.ok(k.includes("recovery_constrained") && k.includes("recovery_completed"), k.join(","));
      assert.equal(refusals(agent).length, 0, "no unsupported form is refused");
      for (const cmd of unsupported) assert.ok(ran.some((r) => JSON.parse(r.args).command === cmd), `${cmd} ran`);
      // run_command is an external action: its exact repeats are polls (spaced by backoff), not loops. The last new
      // information is the first run of the fourth form (request 8); the stagnation window (10) bounds the rest.
      assert.ok(gw.requests.length <= 4 + unsupported.length + 10, `bounded by the stagnation window: ${gw.requests.length}`);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("recovery that preserves legitimate work", () => {
  test("a read-only investigation of distinct files completes with no recovery and nothing refused", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "a.txt": lines("a", 5), "b.txt": lines("b", 5), "c.txt": lines("c", 5) });
    const script: Call[][] = [[read("a.txt")], [read("b.txt"), read("c.txt")], [{ name: "search_code", args: { query: "line 3" } }], [read("a.txt", 2, 4)]];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("All three files have five lines.")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Report how many lines a.txt, b.txt and c.txt have. Do not modify anything.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.equal(ran.length, 5);
      assert.equal(recovery(agent).episode, 0);
      assert.equal(refusals(agent).length, 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a test rerun after changing code runs (commands are never refused), and the task completes", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ "check.sh": "grep -q fixed impl.txt\n", "impl.txt": "broken\n" });
    const script: Call[][] = [[sh("sh check.sh")], [{ name: "write_file", args: { path: "impl.txt", content: "fixed\n" } }], [sh("sh check.sh")]];
    const gw = await startGateway((n) => (n <= script.length ? tools(script[n - 1]) : text("check.sh passes now.")));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Make check.sh pass.");
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
      assert.equal(ran.filter((r) => r.name === "run_command").length, 2);
      assert.equal(refusals(agent).length, 0);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("acknowledging the note and re-planning without new evidence does not reset stagnation or lift the constraint", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 10) });
    const gw = await startGateway((n) =>
      tools([{ name: "update_plan", args: { phases: [{ name: `plan v${n}: re-check f.txt then decide`, status: "in_progress" }] } }, read("f.txt")], `Understood (${n}). I will not repeat myself; I will check f.txt one more time and then act.`));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    const ran = dispatchLog(agent);
    try {
      const turn = await agent.runTurn("Look at f.txt.");
      assert.equal(turn.reason, "STAGNATION_DETECTED", JSON.stringify(turn));
      assert.match(turn.detail ?? "", /recovery exhausted/);
      assert.equal(ran.filter((r) => r.name === "read_file").length, 4, "the 5th and later reads were refused");
      assert.ok(refusals(agent).length >= 2);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("recovery state continuity", () => {
  /** Runs reads of f.txt until constrained recovery begins (4 steps), stopping on the operator's step limit. */
  async function constrainedSession(gwUrl: string, repo: string, sessions: SessionManager, sessionId: string) {
    const agent = quiet(new AutonomousAgent(cfg(gwUrl, repo, { maxSteps: 4, continuation: { ...DEFAULT_CONTINUATION, stagnationSteps: 30, maxRecoveries: 2, maxTotalSteps: 4 } })));
    const save = () =>
      sessions.saveSession({ id: sessionId, workspace: repo, model: "m", messages: agent.getMessages(), objective: agent.getObjective() ?? null, findings: agent.getFindings(), history: agent.getHistoryCompleteness() }, agent.getWorkspacePathIdentity());
    agent.setProgressListener(save);
    const turn = await agent.runTurn("Look at f.txt.");
    assert.equal(turn.reason, "STEP_BUDGET_EXHAUSTED", JSON.stringify(turn));
    assert.equal(recovery(agent).stage, "constrained");
    save();
    agent.setProgressListener(undefined);
    return agent;
  }

  test("session resume while constrained keeps the constraint: the first equivalent read after resume is refused", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 10) });
    const gw = await startGateway((n) => (n <= 5 ? tools([read("f.txt")]) : text("Using what I have: f.txt has 10 lines.")));
    const sessions = new SessionManager(path.join(home, "sessions-resume"), () => WorkspacePath.fromSelectedWorkspace(repo));
    const sessionId = sessions.generateSessionId();
    let first: AutonomousAgent | undefined;
    let restored: AutonomousAgent | undefined;
    try {
      first = await constrainedSession(gw.url, repo, sessions, sessionId);
      const saved = sessions.loadSession(sessionId)!;
      restored = quiet(new AutonomousAgent(cfg(gw.url, repo)));
      restored.restoreConversation(saved, (committed) => sessions.readArchivedHistory(sessionId, committed));
      assert.equal(restored.getObjective()!.execution!.recovery.stage, "constrained", "recovery state restored from the session");
      const ran = dispatchLog(restored);
      const turn = await restored.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      assert.equal(ran.filter((r) => r.name === "read_file").length, 0, "the equivalent read after resume did not run");
      assert.equal(refusals(restored).length >= 1, true);
      assert.equal(turn.execution, "COMPLETED", JSON.stringify(turn));
    } finally {
      first?.shutdown();
      restored?.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("compaction keeps recovery state; a read is refused only while its output is still in the conversation", { timeout: 120_000 }, async () => {
    const repo = makeRepo({ "f.txt": lines("f", 10) });
    const gw = await startGateway((n) => (n <= 6 ? tools([read("f.txt")]) : text("Using what I have.")));
    const sessions = new SessionManager(path.join(home, "sessions-compact"), () => WorkspacePath.fromSelectedWorkspace(repo));
    const sessionId = sessions.generateSessionId();
    let agent: AutonomousAgent | undefined;
    try {
      agent = await constrainedSession(gw.url, repo, sessions, sessionId);
      const result = await agent.compactNow(false);
      assert.equal(result.ok, true, result.message);
      assert.equal(recovery(agent).stage, "constrained", "compaction does not reset recovery");
      // Independent of the tracker: is a whole read_file result for f.txt still a tool message after compaction?
      const readOutputPresent = toolMessages(agent).some((m) => {
        try {
          const r = JSON.parse(String(m.content));
          return r.path === "f.txt" && typeof r.content === "string" && r.end_line === r.total_lines;
        } catch {
          return false;
        }
      });
      const ran = dispatchLog(agent);
      await agent.runTurn("[Nexus] Resume the interrupted turn.", undefined, { resume: true });
      const reads = ran.filter((r) => r.name === "read_file").length;
      if (readOutputPresent) {
        assert.equal(reads, 0, "the output survived compaction, so re-reading it is refused");
      } else {
        assert.equal(reads, 1, "compaction removed the output: one re-acquisition runs, then the in-context repeat is refused");
      }
      assert.ok(refusals(agent).length >= 1);
      assert.equal(recovery(agent).denials >= 1 || recovery(agent).stage === "normal", true);
    } finally {
      agent?.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
