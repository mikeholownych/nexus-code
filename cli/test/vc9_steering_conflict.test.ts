/**
 * VC-9 row 7: steering that would drop a requirement and went undecided in a turn (nobody could be asked, or the turn
 * closed first) ends that turn BLOCKED / NEEDS_INPUT with the decision as a question, and can be decided afterwards by an
 * answer bound to that steering message. Before, the conflict stayed `unresolved` in the ledger with nothing at turn
 * level. Every scenario runs the real agent loop against a deterministic local gateway.
 */
import "./helpers/leak_guard.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AutonomousAgent } from "../src/agent.js";
import { HarnessConfig } from "../src/types.js";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway, makeRepo, makeHome, waitForEvent, Reply } from "./helpers/fixtures.js";
import { carryUnresolvedConflicts, createLedger, recordSteeringConflict, resolveSteeringConflict, settleSteeringConflicts } from "../src/core/objective.js";
import { buildSteeringConflictQuestion, needsInputId } from "../src/core/needs_input.js";
import { parseCommand, safeOperatorText } from "../src/protocol.js";
import { summarizeTurn } from "../src/core/turn.js";

const OBJECTIVE = ["Ship the importer:", "1. Parse the CSV input", "2. Add retry logic to the uploader", "3. Write the migration guide"].join("\n");
const STEER = "Requirement 2 no longer applies.";
const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({ endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true });
const listDir: Reply = { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] };
const stop: Reply = { kind: "text", content: "stopping here" };
async function inferring(agent: AutonomousAgent): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (agent.getTurnLifecycle()?.phase !== "inference") {
    if (Date.now() > deadline) throw new Error("the turn never reached inference");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const statuses = (agent: AutonomousAgent) => agent.getObjective()!.requirements.map((r) => r.status);
const questionId = (id: string, text: string) => needsInputId("steering_conflict", id, text);

/** One turn that is steered while its first request is in flight; later turns run with `after`. */
async function scenario(
  steer: string | undefined,
  onConfirm: ((tool: string, args: Record<string, any>) => Promise<boolean>) | undefined,
  after: (ctx: { agent: AutonomousAgent; first: Awaited<ReturnType<AutonomousAgent["runTurn"]>>; requests: any[] }) => Promise<void>,
  script: (n: number) => Reply = (n) => (n === 1 ? { ...listDir, delayMs: 300 } : stop),
) {
  const gw = await startGateway(script);
  const repo = makeRepo();
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    const pending = agent.runTurn(OBJECTIVE, onConfirm);
    await inferring(agent);
    if (steer) agent.queueSteering("s1", steer);
    const first = await pending;
    await after({ agent, first, requests: gw.requests as any[] });
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("VC-9 row 7: an undecided steering conflict is the turn's question", () => {
  test("nobody could be asked: the turn ends BLOCKED / NEEDS_INPUT with the steering and the requirement it would drop; nothing was applied", { timeout: 60_000 }, async () => {
    await scenario(STEER, undefined, async ({ agent, first, requests }) => {
      assert.equal(first.execution, "BLOCKED");
      assert.equal(first.outcome, "NOT_ESTABLISHED");
      assert.equal(first.reason, "NEEDS_INPUT");
      const q = first.needsInput!;
      assert.equal(q.kind, "steering_conflict");
      assert.deepEqual(q.subject, { steering: "s1", text: STEER, negates: "R2" });
      assert.deepEqual(q.options.map((o) => o.id), ["approve", "decline"]);
      assert.equal(q.id, questionId("s1", STEER));
      assert.match(q.prompt, /would drop R2 and was not applied because no decision was given\. Apply it\?/);
      assert.match(summarizeTurn(first).line, new RegExp(`Send the steering again to decide it at the prompt, or answer with --answer ${q.id}=approve or ${q.id}=decline\\.`));
      assert.deepEqual(statuses(agent), ["open", "open", "open"], "the ledger is unchanged");
      assert.ok(!requests.some((b) => JSON.stringify(b.messages).includes("no longer applies")), "the steering never reached the model");
    });
  });

  test("baseline: the same steer with an operator who decides (either way), and a steer that drops nothing, are not questions", { timeout: 120_000 }, async () => {
    for (const decision of [true, false]) {
      await scenario(STEER, async () => decision, async ({ agent, first }) => {
        assert.notEqual(first.reason, "NEEDS_INPUT", `operator answered ${decision}`);
        assert.equal(first.needsInput, undefined);
        assert.equal(agent.getObjective()!.steeringConflicts![0].status, decision ? "approved" : "declined");
      });
    }
    await scenario("Please keep the log lines short.", undefined, async ({ agent, first }) => {
      assert.notEqual(first.reason, "NEEDS_INPUT");
      assert.equal(agent.getObjective()!.steeringConflicts, undefined);
    });
    await scenario(undefined, undefined, async ({ first }) => assert.notEqual(first.reason, "NEEDS_INPUT"));
  });

  test("the operator was asked but the turn closed first: still undecided, so still the turn's question", { timeout: 60_000 }, async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    try {
      await scenario("Drop requirement 3.", async () => {
        await gate;
        return true;
      }, async ({ agent, first }) => {
        assert.equal(first.reason, "NEEDS_INPUT");
        assert.equal(first.needsInput?.subject.negates, "R3");
        release();
        await (agent as any).steeringDecisions;
        assert.deepEqual(statuses(agent), ["open", "open", "open"], "a late approval of the closed prompt still changes nothing");
      }, (n) => (n === 1 ? { ...listDir, delayMs: 100 } : stop));
    } finally {
      release();
    }
  });

  test("a cancelled turn stays INTERRUPTED: the interruption is the more specific result", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...listDir, delayMs: 300 } : stop));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      const pending = agent.runTurn(OBJECTIVE);
      await inferring(agent);
      agent.queueSteering("s1", STEER);
      agent.requestCancel("operator");
      const turn = await pending;
      assert.equal(turn.execution, "INTERRUPTED");
      assert.equal(turn.needsInput, undefined);
      assert.equal(agent.getObjective()!.steeringConflicts![0].status, "unresolved");
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("VC-9 row 7: deciding the conflict after the turn", () => {
  test("with no answer, the next turn does not ask again: the conflict is carried, still unresolved", { timeout: 60_000 }, async () => {
    await scenario(STEER, undefined, async ({ agent }) => {
      const second = await agent.runTurn("continue");
      assert.notEqual(second.reason, "NEEDS_INPUT", JSON.stringify(second.needsInput));
      const conflict = agent.getObjective()!.steeringConflicts![0];
      assert.deepEqual([conflict.status, conflict.carried], ["unresolved", true]);
      assert.deepEqual(statuses(agent), ["open", "open", "open"]);
    });
  });

  test("approve: the next turn applies the steering once, the requirement is descoped as accepted, and the model sees the steer", { timeout: 60_000 }, async () => {
    await scenario(STEER, undefined, async ({ agent, first, requests }) => {
      agent.setOperatorAnswers(new Map([[first.needsInput!.id, "approve"]]));
      const second = await agent.runTurn("continue");
      assert.notEqual(second.reason, "NEEDS_INPUT");
      const ledger = agent.getObjective()!;
      assert.equal(ledger.steeringConflicts![0].status, "approved");
      const r2 = ledger.requirements.find((r) => r.id === "R2")!;
      assert.deepEqual([r2.status, r2.operatorAccepted], ["descoped", true]);
      assert.match(r2.note ?? "", /operator approved steering s1: Requirement 2 no longer applies\./);
      assert.equal(ledger.steering.filter((s) => s.id === "s1").length, 1);
      assert.ok(requests.some((b) => JSON.stringify(b.messages).includes("no longer applies")), "the approved steer reached the model");
      const third = await agent.runTurn("continue");
      assert.notEqual(third.reason, "NEEDS_INPUT");
      assert.equal(agent.getObjective()!.steering.filter((s) => s.id === "s1").length, 1, "not applied a second time");
    });
  });

  test("decline: the requirement is kept, the steering is never applied, and the conflict is settled", { timeout: 60_000 }, async () => {
    await scenario(STEER, undefined, async ({ agent, first, requests }) => {
      agent.setOperatorAnswers(new Map([[first.needsInput!.id, "decline"]]));
      const second = await agent.runTurn("continue");
      assert.notEqual(second.reason, "NEEDS_INPUT");
      assert.equal(agent.getObjective()!.steeringConflicts![0].status, "declined");
      assert.deepEqual(statuses(agent), ["open", "open", "open"]);
      assert.ok(!requests.some((b) => JSON.stringify(b.messages).includes("no longer applies")));
    });
  });

  test("an answer for another steering message does not decide this one (the id binds the message)", { timeout: 60_000 }, async () => {
    await scenario(STEER, undefined, async ({ agent }) => {
      agent.setOperatorAnswers(new Map([[questionId("s2", STEER), "approve"], [questionId("s1", "Drop requirement 2."), "approve"]]));
      await agent.runTurn("continue");
      assert.equal(agent.getObjective()!.steeringConflicts![0].status, "unresolved");
      assert.deepEqual(statuses(agent), ["open", "open", "open"]);
    });
  });
});

describe("VC-9 row 7: the ledger rules", () => {
  const conflicted = () => {
    const ledger = createLedger(OBJECTIVE);
    const conflict = recordSteeringConflict(ledger, "s1", STEER, ["R2"])!;
    settleSteeringConflicts(ledger);
    return { ledger, conflict };
  };

  test("an unresolved conflict can be decided once; a decided one is not decided again", () => {
    const { ledger, conflict } = conflicted();
    assert.equal(conflict.status, "unresolved");
    assert.equal(resolveSteeringConflict(ledger, conflict, false, "note"), true);
    assert.equal(conflict.status, "declined");
    assert.equal(resolveSteeringConflict(ledger, conflict, true, "note"), false, "a declined conflict is not later approved");
    assert.equal(ledger.requirements.find((r) => r.id === "R2")!.status, "open");
  });

  test("carrying: an answer decides, no answer marks carried, and decided conflicts are left alone", () => {
    const { ledger, conflict } = conflicted();
    assert.deepEqual(carryUnresolvedConflicts(ledger, () => undefined, (t) => t), []);
    assert.equal(conflict.carried, true);
    assert.deepEqual(carryUnresolvedConflicts(ledger, () => true, (t) => t).map((c) => c.id), ["s1"], "a carried conflict can still be answered");
    assert.equal(conflict.status, "approved");
    let asked = 0;
    carryUnresolvedConflicts(ledger, () => (asked++, false), (t) => t);
    assert.equal(asked, 0);
    assert.equal(conflict.status, "approved");
  });

  test("the question shows sanitised steering text, and its id is bound to the raw message", () => {
    const raw = "Drop requirement 2.\x1b[31m\n# heading";
    const q = buildSteeringConflictQuestion({ id: "s1", text: raw, requirements: ["R2", "R3"] }, safeOperatorText);
    assert.ok(!q.subject.text.includes("\x1b"));
    assert.equal(q.subject.negates, "R2, R3");
    assert.equal(q.id, questionId("s1", raw));
  });
});

describe("VC-9 row 7: the sidecar", () => {
  test("the `answer` command parses strictly", () => {
    const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, type: "answer", id: "a1", ...o });
    assert.deepEqual(parseCommand(line({ question: "0123456789ab", option: "approve" })), { type: "answer", id: "a1", question: "0123456789ab", option: "approve" });
    assert.throws(() => parseCommand(line({ question: "short", option: "approve" })), /answer requires question/);
    assert.throws(() => parseCommand(line({ question: "0123456789ab", option: "maybe" })), /answer requires option/);
    assert.throws(() => parseCommand(JSON.stringify({ v: 1, type: "answer", question: "0123456789ab", option: "approve" })), /id/);
  });

  test("a turn whose conflict prompt was never answered ends BLOCKED / NEEDS_INPUT in turn.result; `answer` then decides it at the next turn", { timeout: 90_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] } : { kind: "text", content: "done" }));
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 10, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review", fullAccess: false } as any);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "review", write: (l) => events.push(JSON.parse(l)), historyFile: path.join(home, "history") });
    const send = (m: Record<string, unknown>) => server.handleLine(JSON.stringify({ v: 1, ...m }));
    server.start();
    try {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      const tool = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "write_file");
      await send({ type: "steer", id: "g1", text: "Drop requirement 3." });
      // The tool is approved, the conflict prompt opens, and the turn ends with it unanswered.
      await send({ type: "approve", id: tool.id, always: false });
      await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "steering_conflict");
      const result = await waitForEvent(events, (e) => e.type === "turn.result");
      assert.equal(result.turn.execution, "BLOCKED");
      assert.equal(result.turn.reason, "NEEDS_INPUT");
      assert.equal(result.turn.needsInput.kind, "steering_conflict");
      assert.equal(result.turn.needsInput.subject.negates, "R3");
      await server.idle();

      await send({ type: "answer", id: "a1", question: result.turn.needsInput.id, option: "approve" });
      assert.match(events.filter((e) => e.type === "notice").at(-1).text, new RegExp(`Answer recorded for question ${result.turn.needsInput.id}: approve`));
      const before = events.length;
      await send({ type: "prompt.submit", id: "t2", text: "continue" });
      await waitForEvent(events, (e) => e.type === "turn.result" && events.indexOf(e) >= before);
      await server.idle();
      const ledger = (app.getAgent() as AutonomousAgent).getObjective()!;
      assert.equal(ledger.steeringConflicts![0].status, "approved");
      assert.equal(ledger.requirements.find((r) => r.id === "R3")!.status, "descoped");
    } finally {
      await send({ type: "cancel" });
      await server.idle();
      app.shutdown();
      await gw.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
