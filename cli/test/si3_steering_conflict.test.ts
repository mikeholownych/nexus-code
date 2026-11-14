/**
 * SI-3: steering that negates an objective requirement never silently rewrites the ledger, and a new request that
 * would replace unmet requirements records them instead of dropping them without a trace.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { HarnessConfig } from "../src/types.js";
import path from "node:path";
import { ApplicationCore } from "../src/core/app.js";
import { SidecarServer } from "../src/sidecar.js";
import { startGateway, makeRepo, makeHome, waitForEvent, Reply } from "./helpers/fixtures.js";
import { createLedger, steeringNegations } from "../src/core/objective.js";
import { toolSubject } from "../src/protocol.js";
import { buildSessionExport } from "../src/session_export.js";

const OBJECTIVE = ["Ship the importer:", "1. Parse the CSV input", "2. Add retry logic to the uploader", "3. Write the migration guide"].join("\n");
const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({ endpoint, model: "m", maxSteps: 30, temperature: 0, workspace, shell: "bash", approvalMode: "auto", fullAccess: true });
const listDir: Reply = { kind: "tools", calls: [{ name: "list_dir", args: { path: "." } }] };
async function inferring(agent: AutonomousAgent): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (agent.getTurnLifecycle()?.phase !== "inference") {
    if (Date.now() > deadline) throw new Error("the turn never reached inference");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const statuses = (agent: AutonomousAgent) => agent.getObjective()!.requirements.map((r) => r.status);

async function steered(text: string, onConfirm?: (tool: string, args: Record<string, any>) => Promise<boolean>) {
  const gw = await startGateway((n) => (n === 1 ? { ...listDir, delayMs: 300 } : { kind: "text", content: "stopping here" }));
  const repo = makeRepo();
  const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
  try {
    const pending = agent.runTurn(OBJECTIVE, onConfirm);
    await inferring(agent);
    const queued = agent.queueSteering("s1", text);
    await pending;
    return { queued, ledger: agent.getObjective()!, requests: gw.requests as any[], agent };
  } finally {
    agent.shutdown();
    await gw.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe("steeringNegations (deterministic detection)", () => {
  const ledger = createLedger(OBJECTIVE);
  const neg = (text: string) => steeringNegations(ledger, text);
  test("explicit negation of a numbered requirement", () => {
    assert.deepEqual(neg("Drop requirement 3."), ["R3"]);
    assert.deepEqual(neg("please skip R2 and R3"), ["R2", "R3"]);
    assert.deepEqual(neg("Don't do requirement 3"), ["R3"]);
    assert.deepEqual(neg("Requirement 2 no longer applies."), ["R2"]);
    assert.deepEqual(neg("ignore R1, keep going"), ["R1"]);
  });
  test("steer text contradicting a requirement's own wording", () => {
    assert.deepEqual(neg("Actually don't add retry logic to the uploader."), ["R2"]);
  });
  test("false-positive guards", () => {
    assert.deepEqual(neg("How is requirement 3 going?"), []);
    assert.deepEqual(neg("Don't forget requirement 3."), []);
    assert.deepEqual(neg("Do not ignore requirement 3."), []);
    assert.deepEqual(neg("I don't want you to skip requirement 2."), []);
    assert.deepEqual(neg("Add a requirement 4: log every upload."), []);
    assert.deepEqual(neg("Don't forget to add retry logic to the uploader."), []);
    assert.deepEqual(neg("Please also add retry logic to the uploader."), []);
    assert.deepEqual(neg("Drop the old config file."), []);
    assert.deepEqual(neg("Skip step 3 in the deploy script."), []);
    assert.deepEqual(neg("Ignore point 2 of the style guide and item 1 of the list."), []);
    assert.deepEqual(neg("Stop requirement 3 from failing."), []);
    assert.deepEqual(neg("Don't do requirement 3 yet."), []);
    assert.deepEqual(neg("Skip requirement 3 for now, then come back."), []);
    assert.deepEqual(neg("Drop requirement 3 until the API is ready."), []);
    assert.deepEqual(neg('The reviewer wrote "drop requirement 3" and I disagree.'), []);
    assert.deepEqual(neg("The log says:\n```\nskip requirement 3\n```\nWhy?"), []);
    assert.deepEqual(neg("grep for `ignore R2` in the notes"), []);
  });
  test("a requirement already done is not negated, and unknown numbers are ignored", () => {
    const done = createLedger(OBJECTIVE);
    done.requirements[2].status = "verified";
    assert.deepEqual(steeringNegations(done, "drop requirement 3"), []);
    assert.deepEqual(neg("drop requirement 9"), []);
  });
});

describe("steering conflict at the agent layer", () => {
  test("a conflicting steer keeps the ledger and raises an operator decision; declining changes nothing", { timeout: 60_000 }, async () => {
    const asked: any[] = [];
    const { queued, ledger, requests } = await steered("Drop requirement 3.", async (tool, args) => {
      asked.push({ tool, args });
      return false;
    });
    assert.deepEqual(queued, { status: "conflict", requirements: ["R3"], held: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].tool, "steering_conflict");
    assert.deepEqual(asked[0].args.negates.map((n: any) => n.id), ["R3"]);
    assert.deepEqual(ledger.requirements.map((r) => r.status), ["open", "open", "open"]);
    assert.equal(ledger.steeringConflicts?.[0].status, "declined");
    assert.equal(ledger.steering.length, 0);
    assert.ok(!requests.some((b) => JSON.stringify(b.messages).includes("Drop requirement 3")), "the steer never reached the model");
  });

  test("operator approval descopes the requirement (accepted), records it, and applies the steer", { timeout: 60_000 }, async () => {
    const { ledger, requests } = await steered("Drop requirement 3.", async () => true);
    const r3 = ledger.requirements[2];
    assert.equal(r3.status, "descoped");
    assert.equal(r3.operatorAccepted, true);
    assert.equal(ledger.requirements[0].status, "open");
    assert.equal(ledger.steeringConflicts?.[0].status, "approved");
    assert.ok(ledger.scopeChanges.some((c) => c.requirement === "R3" && c.to === "descoped" && /operator approved steering s1/.test(c.reason)));
    assert.ok(ledger.steering.some((s) => s.id === "s1"));
    assert.ok(requests.some((b) => JSON.stringify(b.messages).includes("Drop requirement 3")), "the approved steer reached the model");
  });

  test("headless: the ledger is kept, the conflict is recorded, the negation is not applied", { timeout: 60_000 }, async () => {
    const { queued, ledger, requests } = await steered("Requirement 2 no longer applies.");
    assert.equal(queued.status, "conflict");
    assert.deepEqual(ledger.requirements.map((r) => r.status), ["open", "open", "open"]);
    assert.deepEqual(ledger.steeringConflicts?.map((c) => [c.id, c.status, c.requirements]), [["s1", "unresolved", ["R2"]]]);
    assert.ok(!requests.some((b) => JSON.stringify(b.messages).includes("no longer applies")));
  });

  test("a non-conflicting steer is queued and applied as before", { timeout: 60_000 }, async () => {
    for (const text of ["How is requirement 3 going?", "Don't forget requirement 3.", "Add a requirement 4: log every upload."]) {
      const { queued, ledger, requests } = await steered(text, async () => assert.fail("no decision expected"));
      assert.equal(queued.status, "queued", text);
      assert.equal(ledger.steeringConflicts, undefined);
      assert.deepEqual(ledger.requirements.map((r) => r.status), ["open", "open", "open"]);
      assert.ok(requests.some((b) => JSON.stringify(b.messages).includes(text)), text);
    }
  });
});

describe("decisions are serialised and bound to their ledger and turn", () => {
  test("two back-to-back conflicting steers are asked one at a time, in order", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...listDir, delayMs: 400 } : { kind: "text", content: "stopping here" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    let open = 0;
    let maxOpen = 0;
    const order: string[] = [];
    try {
      const pending = agent.runTurn(OBJECTIVE, async (_tool, args) => {
        order.push(args.steering);
        maxOpen = Math.max(maxOpen, ++open);
        await new Promise((r) => setTimeout(r, 30));
        open--;
        return true;
      });
      await inferring(agent);
      assert.equal(agent.queueSteering("s1", "Drop requirement 2.").status, "conflict");
      assert.equal(agent.queueSteering("s2", "Drop requirement 3.").status, "conflict");
      await pending;
      assert.equal(maxOpen, 1);
      assert.deepEqual(order, ["s1", "s2"]);
      assert.deepEqual(agent.getObjective()!.requirements.map((r) => r.status), ["open", "descoped", "descoped"]);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an approval that arrives after the turn closed descopes nothing and the conflict stays unresolved", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...listDir, delayMs: 100 } : { kind: "text", content: "stopping here" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    try {
      const pending = agent.runTurn(OBJECTIVE, async () => {
        await gate;
        return true;
      });
      await inferring(agent);
      agent.queueSteering("s1", "Drop requirement 3.");
      await pending;
      assert.equal(agent.getObjective()!.steeringConflicts![0].status, "unresolved");
      release();
      await (agent as any).steeringDecisions;
      const ledger = agent.getObjective()!;
      assert.deepEqual(ledger.requirements.map((r) => r.status), ["open", "open", "open"]);
      assert.equal(ledger.steeringConflicts![0].status, "unresolved");
      assert.equal(ledger.steering.length, 0);
    } finally {
      release();
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a decision for a replaced ledger is not applied to the new one", { timeout: 60_000 }, async () => {
    const gw = await startGateway((n) => (n === 1 ? { ...listDir, delayMs: 100 } : { kind: "text", content: "stopping here" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    try {
      const pending = agent.runTurn(OBJECTIVE, () => gate.then(() => true));
      await inferring(agent);
      agent.queueSteering("s1", "Drop requirement 3.");
      await pending;
      agent.clearObjective();
      await agent.runTurn("Rename the flag.");
      release();
      await (agent as any).steeringDecisions;
      assert.deepEqual(agent.getObjective()!.requirements.map((r) => r.status), ["open"]);
      assert.equal(agent.getObjective()!.steering.length, 0);
    } finally {
      release();
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("control characters and secrets in the steer never reach the prompt, the note or the export", { timeout: 60_000 }, async () => {
    let shown = "";
    const { ledger } = await steered("Drop requirement 3.\x1b[31m RED\x07\x1b]0;title\x07 token sk-abcdefghijklmnopqrstuvwxyz123456", async (_tool, args) => {
      shown = JSON.stringify(args);
      return true;
    });
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(shown.replace(/\\u00[0-1][0-9a-f]/g, "")), shown);
    assert.ok(!shown.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
    assert.ok(!/[\x00-\x1f\x7f]/.test(ledger.requirements[2].note ?? ""));
    assert.ok(!(ledger.requirements[2].note ?? "").includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  });
});

describe("persistence and export", () => {
  test("conflicts and superseded records survive a save/restore round trip; an older ledger loads unchanged", () => {
    const ledger = createLedger(OBJECTIVE);
    ledger.steeringConflicts = [{ id: "s1", text: "Drop requirement 3.\n| x |", requirements: ["R3"], receivedAt: "t", status: "unresolved" }];
    ledger.superseded = [{ at: "t", objective: "old", objectiveSha256: "h", requirements: [{ id: "R1", text: "x", status: "open" }], status: "pending_decision" }];
    const restored = JSON.parse(JSON.stringify(ledger));
    assert.deepEqual(restored.steeringConflicts, ledger.steeringConflicts);
    assert.deepEqual(restored.superseded, ledger.superseded);
    const old = JSON.parse(JSON.stringify(createLedger(OBJECTIVE)));
    assert.equal(old.steeringConflicts, undefined);
    assert.deepEqual(steeringNegations(old, "How is requirement 3 going?"), []);
  });

  test("the export lists conflicts and superseded requirements, flattened", () => {
    const ledger = createLedger(OBJECTIVE);
    ledger.steeringConflicts = [{ id: "s1", text: "Drop requirement 3.\n\n# Injected heading\x1b[31m", requirements: ["R3"], receivedAt: "t", status: "unresolved" }];
    ledger.superseded = [{ at: "t", objective: "old", objectiveSha256: "h", requirements: [{ id: "R1", text: "fix it", status: "open" }], status: "pending_decision" }];
    const session = { id: "x", status: "idle", objective: ledger, messages: [], lastTurn: null } as any;
    const manager = { readArchivedHistory: () => ({ messages: [], unreadableLines: 0 }) } as any;
    const exported = buildSessionExport(manager, session);
    const json = JSON.stringify((exported.json as any).export.taskState);
    assert.match(json, /steeringConflicts/);
    assert.match(json, /supersededObjectives/);
    const md = exported.markdown;
    assert.match(md, /s1 \[unresolved\] negates R3: Drop requirement 3\. # Injected heading/);
    assert.ok(!md.includes("\x1b"));
    assert.match(md, /pending_decision/);
  });
});

describe("a new request that replaces unmet requirements", () => {
  test("the old objective and its unmet requirements stay on the new ledger as pending a decision", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "ok" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Fix the flaky parser test.");
      const first = agent.getObjective()!;
      first.outcome = undefined;
      assert.ok(first.requirements.some((r) => r.status === "open"));
      await agent.runTurn("Now rename the CLI flag --old to --new.");
      const next = agent.getObjective()!;
      assert.match(next.objective, /rename the CLI flag/);
      assert.equal(next.superseded?.length, 1);
      assert.equal(next.superseded![0].status, "pending_decision");
      assert.equal(next.superseded![0].objective, "Fix the flaky parser test.");
      assert.deepEqual(next.superseded![0].requirements.map((r) => r.id), ["R1"]);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a resolved objective is replaced without a record", { timeout: 60_000 }, async () => {
    const gw = await startGateway(() => ({ kind: "text", content: "ok" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Fix the flaky parser test.");
      const first = agent.getObjective()!;
      first.outcome = { status: "completed", reason: "done" } as any;
      first.requirements.forEach((r) => (r.status = "verified"));
      await agent.runTurn("Now rename the CLI flag --old to --new.");
      assert.equal(agent.getObjective()!.superseded, undefined);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("steering conflicts through the sidecar", () => {
  async function rig(script: (n: number) => Reply, fn: (r: { server: SidecarServer; events: any[]; agent: AutonomousAgent; send: (m: Record<string, unknown>) => Promise<void> }) => Promise<void>) {
    const gw = await startGateway(script);
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 10, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review", fullAccess: false } as any);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "review", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
    server.start();
    try {
      await fn({ server, events, agent: app.getAgent() as any, send: (m) => server.handleLine(JSON.stringify({ v: 1, ...m })) });
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
      app.shutdown();
      await gw.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  const writeFirst = (n: number): Reply => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] } : { kind: "text", content: "done" });
  const ackStatuses = (events: any[], id: string) => events.filter((e) => e.type === "steer.ack" && e.id === id).map((e) => e.status);
  const approvals = (events: any[]) => events.filter((e) => e.type === "approval.request");

  test("a conflict during an open tool approval waits behind it, is acked held, and shows the ids and text", async () => {
    await rig(writeFirst, async ({ server, events, agent, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      const tool = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "write_file");
      await send({ type: "steer", id: "g1", text: "Drop requirement 3.\x1b[31m" });
      assert.deepEqual(ackStatuses(events, "g1"), ["held"]);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(approvals(events).length, 1, "the tool approval is still the only open one");
      await send({ type: "approve", id: tool.id, always: false });
      const conflict = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "steering_conflict");
      assert.match(conflict.subject, /g1 negates R3: Drop requirement 3\./);
      assert.ok(!conflict.subject.includes("\x1b"));
      assert.match(conflict.preview, /Write the migration guide/);
      await send({ type: "deny", id: conflict.id });
      await server.idle();
      assert.deepEqual(ackStatuses(events, "g1"), ["held", "cancelled"]);
      assert.match(events.find((e) => e.type === "steer.ack" && e.status === "cancelled")?.text, /^Drop requirement 3\./);
      assert.deepEqual(agent.getObjective()!.requirements.map((r: any) => r.status), ["open", "open", "open"]);
    });
  });

  test("a resent conflicting steer is a duplicate and an approved one is applied once, even after an always-approve", async () => {
    await rig(writeFirst, async ({ server, events, agent, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      const tool = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "write_file");
      await send({ type: "approve", id: tool.id, always: true });
      await new Promise((r) => setTimeout(r, 50));
      await send({ type: "steer", id: "g1", text: "Drop requirement 3." });
      await send({ type: "steer", id: "g1", text: "Drop requirement 3." });
      assert.deepEqual(ackStatuses(events, "g1").slice(0, 2), ["held", "duplicate"]);
      const conflict = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "steering_conflict");
      await send({ type: "approve", id: conflict.id, always: true });
      await server.idle();
      assert.equal(agent.getObjective()!.requirements[2].status, "descoped");
      assert.equal(agent.getObjective()!.steering.filter((s: any) => s.id === "g1").length, 1);
      assert.equal(ackStatuses(events, "g1").filter((s: string) => s === "applied").length, 1);
    });
  });
});

describe("a conflict prompt never outlives its turn", () => {
  const readFirst = (n: number, body?: any): Reply => {
    if (n === 1) return { kind: "tools", calls: [{ name: "read_file", args: { path: "base.txt" } }], delayMs: 400 };
    const messages = (body?.messages ?? []) as any[];
    const last = messages[messages.length - 1];
    const wantsWrite = messages.some((m) => m.role === "user" && String(m.content).startsWith("write x"));
    return wantsWrite && last?.role === "user" && String(last.content).startsWith("write x") ? { kind: "tools", calls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] } : { kind: "text", content: "done" };
  };
  const statuses = (events: any[], id: string) => events.filter((e) => e.type === "steer.ack" && e.id === id).map((e) => e.status);
  async function sidecarRig(fn: (r: { server: SidecarServer; events: any[]; repo: string; send: (m: Record<string, unknown>) => Promise<void> }) => Promise<void>) {
    const gw = await startGateway((n, body) => readFirst(n, body));
    const repo = makeRepo();
    const home = makeHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const app = new ApplicationCore({ endpoint: gw.url, model: "m", maxSteps: 10, temperature: 0, workspace: repo, shell: "bash", approvalMode: "review", fullAccess: false } as any);
    const events: any[] = [];
    const server = new SidecarServer({ app, mode: "review", write: (line) => events.push(JSON.parse(line)), historyFile: path.join(home, "history") });
    server.start();
    try {
      await fn({ server, events, repo, send: (m) => server.handleLine(JSON.stringify({ v: 1, ...m })) });
    } finally {
      await server.handleLine(JSON.stringify({ v: 1, type: "cancel" }));
      await server.idle();
      app.shutdown();
      await gw.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  test("the turn ends with a held conflict: the steer comes back, and the next turn's tool approval is not blocked", async () => {
    await sidecarRig(async ({ server, events, repo, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      await waitForEvent(events, (e) => e.type === "activity" && e.phase === "inference");
      await send({ type: "steer", id: "g1", text: "Drop requirement 3." });
      await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "steering_conflict");
      await server.idle();
      assert.deepEqual(statuses(events, "g1"), ["held", "cancelled"]);
      const cancelled = events.find((e) => e.type === "steer.ack" && e.status === "cancelled");
      assert.match(cancelled.message, /the turn ended before you decided/);
      assert.equal(cancelled.text, "Drop requirement 3.");
      await send({ type: "prompt.submit", id: "t2", text: "write x" });
      const tool = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "write_file");
      await send({ type: "approve", id: tool.id, always: false });
      await server.idle();
      assert.ok(fs.existsSync(path.join(repo, "x.txt")));
    });
  });

  test("two held conflicts when the turn ends: both come back, the second prompt is never opened", async () => {
    await sidecarRig(async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      await waitForEvent(events, (e) => e.type === "activity" && e.phase === "inference");
      await send({ type: "steer", id: "g1", text: "Drop requirement 2." });
      await send({ type: "steer", id: "g2", text: "Drop requirement 3." });
      await server.idle();
      assert.deepEqual(statuses(events, "g1"), ["held", "cancelled"]);
      assert.deepEqual(statuses(events, "g2"), ["held", "cancelled"]);
      assert.equal(events.filter((e) => e.type === "approval.request" && e.tool === "steering_conflict").length, 1);
    });
  });

  test("a denied tool approval keeps its own denial while a steering prompt waits behind it", async () => {
    await sidecarRig(async ({ server, events, send }) => {
      await send({ type: "prompt.submit", id: "t1", text: OBJECTIVE });
      await waitForEvent(events, (e) => e.type === "activity" && e.phase === "inference");
      await send({ type: "prompt.submit", id: "t1b", text: "x" }).catch(() => {});
      await server.idle();
      await send({ type: "prompt.submit", id: "t2", text: "write x" });
      const tool = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "write_file");
      await send({ type: "steer", id: "g2", text: "Drop requirement 3." });
      await send({ type: "deny", id: tool.id });
      const end = await waitForEvent(events, (e) => e.type === "tool.end" && e.tool === "write_file");
      assert.equal(end.summary, "Denied by you");
      const steering = await waitForEvent(events, (e) => e.type === "approval.request" && e.tool === "steering_conflict");
      await send({ type: "deny", id: steering.id });
      await server.idle();
    });
  });

  test("a model tool call with a negates field cannot spoof the approval subject", () => {
    const args = { command: "rm -rf build", steering: "s9", text: "harmless", negates: [{ id: "R1" }] };
    assert.equal(toolSubject(args, "run_command"), "rm -rf build");
    assert.match(toolSubject({ steering: "s9", text: "harmless", negates: [{ id: "R1" }] }, "steering_conflict"), /^steering s9 negates R1: harmless/);
  });
});

describe("REPL steering decision", () => {
  test("the question is bound to the conflict's signal, and a withdrawn question answers no", async () => {
    const { InteractiveRepl } = await import("../src/repl.js");
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const fake = {
      rl: {},
      askDuringTurn: async (_q: string, o: { signal?: AbortSignal }) => {
        seen = o.signal;
        abort.abort();
        return o.signal?.aborted ? null : "y";
      },
    };
    const confirm = (InteractiveRepl.prototype as any).confirmSteeringConflict;
    const quiet = console.log;
    console.log = () => {};
    try {
      assert.equal(await confirm.call(fake, { steering: "s1", text: "Drop requirement 3.", negates: [{ id: "R3", text: "x" }] }, abort.signal), false);
    } finally {
      console.log = quiet;
    }
    assert.equal(seen, abort.signal);
    assert.equal(await confirm.call({ rl: undefined }, { steering: "s1", text: "t", negates: [] }), false);
  });
});
