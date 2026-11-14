/**
 * SI-3: steering that negates an objective requirement never silently rewrites the ledger, and a new request that
 * would replace unmet requirements records them instead of dropping them without a trace.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import { createLedger, steeringNegations } from "../src/core/objective.js";

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
    assert.deepEqual(neg("ignore item 1, keep going"), ["R1"]);
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
    assert.deepEqual(queued, { status: "conflict", requirements: ["R3"] });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].tool, "steering_conflict");
    assert.deepEqual(asked[0].args.negates, ["R3"]);
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
