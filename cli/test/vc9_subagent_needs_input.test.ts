import "./helpers/leak_guard.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { AutonomousAgent } from "../src/agent.js";
import { DurableStateManager } from "../src/core/state.js";
import { RustCoreBridge } from "../src/tools.js";
import { buildNeedsInput, parseAnswers } from "../src/core/needs_input.js";
import { createLedger } from "../src/core/objective.js";
import { summarizeTurn, exitCodeForTurn, assertTurnResultInvariants } from "../src/core/turn.js";
import { startGateway, Reply } from "./helpers/fixtures.js";

// VC-9 (subagents): a delegated subagent's headless decision is returned to its parent and ends the parent's run
// BLOCKED / NEEDS_INPUT; it is never taken by the subagent. Also the requirement-verifier approval on its own.

let repo: string;
let stateDir: string;
let home: string;
let previousHome: string | undefined;
const agents: AutonomousAgent[] = [];
const bridges: RustCoreBridge[] = [];

function makeAgent(endpoint = "http://127.0.0.1:9/v1", depth = 0, worktree = false): AutonomousAgent {
  const config = { endpoint, model: "m", maxSteps: 8, temperature: 0, workspace: repo, shell: "bash", worktree } as any;
  const agent = depth === 0 ? new AutonomousAgent(config) : new AutonomousAgent(config, depth, { durable: false });
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  if (depth === 0) {
    const a = agent as any;
    a.stateManager = new DurableStateManager({ baseDir: stateDir, workspacePaths: [a.primaryWorkspacePathIdentity] });
  }
  agent.setApprovalMode("review");
  agents.push(agent);
  return agent;
}
const pending = (agent: AutonomousAgent) => (agent as any).pendingNeedsInput;
const WRITE = { path: "a.txt", content: "x" };

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9s-home-"));
  process.env.HOME = home;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9s-repo-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vc9s-state-"));
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execSync("git init -q && git config user.name t && git config user.email t@t.invalid && git add . && git commit -qm base", { cwd: repo, stdio: "ignore" });
});
afterEach(() => {
  for (const a of agents.splice(0)) {
    if (a.getActiveWorktree()) a.discardActiveWorktree();
    a.shutdown();
  }
  for (const b of bridges.splice(0)) b.shutdown();
  for (const d of [repo, stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

interface Script { parent: Reply[]; child: Reply[] }
/** A gateway that answers by who is asking: the parent or its subagent (a subagent cannot spawn another). */
async function scripted(s: Script) {
  const seen = { parent: 0, child: 0 };
  const gw = await startGateway((_n, body) => {
    const text = JSON.stringify(body?.messages ?? []);
    const who = text.includes("[Subagent Objective]") ? "child" : "parent";
    const list = who === "parent" ? s.parent : s.child;
    return list[Math.min(seen[who]++, list.length - 1)];
  });
  return { gw, seen };
}
const spawn = (prompt: string): Reply => ({ kind: "tools", calls: [{ name: "spawn_subagent", args: { prompt, profile: "implementer" } }] });
const write: Reply = { kind: "tools", calls: [{ name: "write_file", args: WRITE }] };

describe("VC-9: a subagent's question reaches the parent's result", () => {
  test("headless: the parent ends BLOCKED / NEEDS_INPUT with the subagent's question; the subagent neither waits nor approves", { timeout: 60_000 }, async () => {
    const { gw, seen } = await scripted({ parent: [spawn("write a.txt"), { kind: "text", content: "never reached" }], child: [write, { kind: "text", content: "routed around" }] });
    try {
      const parent = makeAgent(gw.url, 0, true);
      const turn = await parent.runTurn("delegate the write");
      assert.equal(turn.execution, "BLOCKED");
      assert.equal(turn.reason, "NEEDS_INPUT");
      assert.equal(turn.outcome, "NOT_ESTABLISHED");
      assert.equal(turn.needsInput?.kind, "tool_approval");
      assert.equal(turn.needsInput?.subject.tool, "write_file");
      assert.deepEqual(turn.needsInput?.subagent, { depth: 1, objective: "write a.txt" });
      assert.deepEqual(turn.needsInput?.options.map((o) => o.id), ["approve", "decline"]);
      assert.equal(turn.furtherNeedsInput, undefined);
      assert.equal(exitCodeForTurn(turn), 1);
      assert.match(summarizeTurn(turn).line, new RegExp(`NEEDS_INPUT ${turn.needsInput!.id}`));
      // No auto-approval and no hang: the file is untouched, the child made one request and stopped at the question.
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
      assert.equal(seen.child, 1, "the subagent stopped at the question instead of routing around it");
      assert.equal(seen.parent, 1, "the parent stopped with the question instead of asking the model again");
      assert.equal(turn.needsInput?.subject.tool, "write_file", "the child approval decision is surfaced on the parent turn");
    } finally {
      await gw.close();
    }
  });

  test("the question has the same id as the one a parent-originated call would raise, so `--answer` resumes it", { timeout: 60_000 }, async () => {
    const { gw } = await scripted({ parent: [spawn("write a.txt"), { kind: "text", content: "x" }], child: [write] });
    const direct = makeAgent();
    await (direct as any).dispatchToolCall({ id: "d1", type: "function", function: { name: "write_file", arguments: JSON.stringify(WRITE) } }, 1, "agent");
    try {
      const turn = await makeAgent(gw.url, 0, true).runTurn("delegate the write");
      assert.equal(turn.needsInput?.id, pending(direct).id);
    } finally {
      await gw.close();
    }
  });

  test("--answer resume: approve lets the re-spawned subagent run the action; decline refuses it without asking again", { timeout: 90_000 }, async () => {
    for (const answer of ["approve", "decline"] as const) {
      fs.rmSync(path.join(repo, "a.txt"), { force: true });
      const { gw } = await scripted({ parent: [spawn("write a.txt"), spawn("write a.txt"), { kind: "text", content: "all done" }], child: [write, write, { kind: "text", content: "child report" }] });
      try {
        const parent = makeAgent(gw.url, 0, true);
        const blocked = await parent.runTurn("delegate the write");
        assert.equal(blocked.reason, "NEEDS_INPUT");
        parent.setOperatorAnswers(parseAnswers([`${blocked.needsInput!.id}=${answer}`]));
        const resumed = await parent.runTurn("continue");
        assert.notEqual(resumed.reason, "NEEDS_INPUT", `${answer}: the answered question is not asked again`);
        assert.equal(resumed.needsInput, undefined);
        const workspace = parent.getActiveWorktree()?.worktreePath ?? repo;
        assert.equal(fs.existsSync(path.join(workspace, "a.txt")), answer === "approve", `${answer}: the subagent's write happened only on approve`);
      } finally {
        await gw.close();
      }
    }
  });

  test("an answer for another decision does not approve the subagent's", { timeout: 60_000 }, async () => {
    const { gw } = await scripted({ parent: [spawn("write a.txt"), { kind: "text", content: "x" }], child: [write] });
    try {
      const parent = makeAgent(gw.url, 0, true);
      parent.setOperatorAnswers(parseAnswers([`${buildNeedsInput("tool_approval", "p", {}, "write_file", '{"other":1}').id}=approve`]));
      const turn = await parent.runTurn("delegate the write");
      assert.equal(turn.reason, "NEEDS_INPUT");
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), false);
    } finally {
      await gw.close();
    }
  });
});

describe("VC-9: more than one subagent question", () => {
  const q = (n: string) => buildNeedsInput("tool_approval", `allow ${n}?`, { tool: n }, n);

  test("a subagent records every question it raised once, with its identity, and the first is not replaced", async () => {
    const child = makeAgent(undefined, 1);
    (child as any).subagentObjective = "inspect";
    const c = child as any;
    assert.equal(c.headlessDecision(q("a")), "ask");
    assert.equal(c.headlessDecision(q("b")), "ask");
    assert.equal(c.headlessDecision(q("a")), "ask", "the same decision twice is one question");
    assert.deepEqual(c.subagentQuestions.map((x: any) => x.subject.tool), ["a", "b"]);
    assert.deepEqual(c.subagentQuestions[0].subagent, { depth: 1, objective: "inspect" });
    assert.equal(pending(child), undefined, "a subagent never records a turn-level question itself");
  });

  test("the parent surfaces the first and lists the rest; a repeat is not listed; its own earlier question stays first", async () => {
    const parent = makeAgent();
    const own = q("own");
    (parent as any).pendingNeedsInput = own;
    parent.acceptSubagentQuestions([q("a"), q("b"), q("a"), own]);
    assert.equal(pending(parent).id, own.id);
    assert.deepEqual((parent as any).furtherNeedsInput.map((x: any) => x.subject.tool), ["a", "b"]);

    const fresh = makeAgent();
    fresh.acceptSubagentQuestions([q("a"), q("b")]);
    assert.equal(pending(fresh).subject.tool, "a");
    const turn = (fresh as any).buildTurnResult({ modelStop: "NONE", finalOutputComplete: false, inferenceFailure: null, interruption: null, limitReached: true, stepsUsed: 1, stopReason: "NEEDS_INPUT" });
    assert.equal(turn.reason, "NEEDS_INPUT");
    assert.equal(turn.needsInput.subject.tool, "a");
    assert.deepEqual(turn.furtherNeedsInput.map((x: any) => x.subject.tool), ["b"]);
    assert.match(summarizeTurn(turn).line, new RegExp(`1 more question\\(s\\) wait behind it: ${q("b").id}`));
    assert.throws(() => assertTurnResultInvariants({ ...turn, needsInput: undefined, reason: "FAILED", furtherNeedsInput: [q("b")] }), /NEEDS_INPUT|furtherNeedsInput/);
  });

  test("a new turn starts with no queued questions", { timeout: 60_000 }, async () => {
    const { gw } = await scripted({ parent: [{ kind: "text", content: "hi" }], child: [] });
    try {
      const parent = makeAgent(gw.url);
      parent.acceptSubagentQuestions([q("a"), q("b")]);
      const turn = await parent.runTurn("hello");
      assert.equal(turn.needsInput, undefined);
      assert.equal(turn.furtherNeedsInput, undefined);
    } finally {
      await gw.close();
    }
  });
});

describe("VC-9: unchanged paths", () => {
  test("interactive: with an operator the subagent asks through it, nothing is recorded and no question is returned", { timeout: 60_000 }, async () => {
    for (const approve of [true, false]) {
      fs.rmSync(path.join(repo, "a.txt"), { force: true });
      const { gw } = await scripted({ parent: [spawn("write a.txt"), { kind: "text", content: "done" }], child: [write, { kind: "text", content: "child report" }] });
      try {
        const asked: string[] = [];
        const parent = makeAgent(gw.url, 0, true);
        const turn = await parent.runTurn("delegate the write", async (tool) => { asked.push(tool); return approve; });
        assert.notEqual(turn.reason, "NEEDS_INPUT");
        assert.equal(turn.needsInput, undefined);
        assert.ok(asked.includes("write_file"), "the operator was asked");
        const workspace = parent.getActiveWorktree()?.worktreePath ?? repo;
        assert.equal(fs.existsSync(path.join(workspace, "a.txt")), approve);
        assert.equal(pending(parent), undefined);
      } finally {
        await gw.close();
      }
    }
  });

  test("depth 0: a parent-originated question still ends the turn as before, with no subagent identity and nothing queued", { timeout: 60_000 }, async () => {
    const { gw } = await scripted({ parent: [write, { kind: "text", content: "done" }], child: [] });
    try {
      const parent = makeAgent(gw.url);
      const turn = await parent.runTurn("write a.txt");
      assert.equal(turn.reason, "NEEDS_INPUT");
      assert.equal(turn.needsInput?.kind, "tool_approval");
      assert.equal(turn.needsInput?.subagent, undefined);
      assert.equal(turn.furtherNeedsInput, undefined);
      assert.equal(JSON.stringify(Object.keys(turn.needsInput!).sort()), JSON.stringify(["id", "kind", "options", "prompt", "subject"]));
    } finally {
      await gw.close();
    }
  });
});

describe("VC-9: the requirement verifier's approval, on its own", () => {
  const REQ = { id: "R1", verifierSource: "model" };
  const withLedger = (agent: AutonomousAgent) => { (agent as any).objective = createLedger("objective"); return agent as any; };
  const run = (a: any, command = "true", req = REQ) => a.runRequirementVerifier(req, command) as Promise<string | undefined>;

  test("no operator: the verifier is not run, the refusal says so, and a question bound to the command and its requirement is recorded", async () => {
    const a = withLedger(makeAgent());
    const result = await run(a);
    assert.match(result!, /R1: verifier execution was not approved \(it requires operator approval and no operator is present\)/);
    assert.equal(a.objective.verification.length, 0, "nothing ran");
    const q = pending(a);
    assert.equal(q.kind, "verifier_approval");
    assert.equal(q.subject.command, "true");
    assert.match(q.prompt, /model-declared verifier for R1: true/);
    const op = withLedger(makeAgent());
    await run(op, "true", { id: "R2", verifierSource: "operator" });
    assert.match(pending(op).prompt, /operator-declared verifier for R2/);
  });

  test("a recorded approve runs it once and records a PASSED attempt against the requirement; another command is still asked", async () => {
    const a = withLedger(makeAgent());
    await run(a);
    const q = pending(a);
    a.pendingNeedsInput = undefined;
    a.setOperatorAnswers(parseAnswers([`${q.id}=approve`]));
    assert.equal(await run(a), undefined);
    const attempt = a.objective.verification.at(-1);
    assert.equal(attempt.requirementId, "R1");
    assert.equal(attempt.status, "PASSED");
    assert.equal(pending(a), undefined);
    assert.match((await run(a, "echo other"))!, /not approved/);
    assert.notEqual(pending(a).id, q.id);
  });

  test("a recorded decline refuses without asking again and nothing runs", async () => {
    const a = withLedger(makeAgent());
    await run(a);
    const q = pending(a);
    a.pendingNeedsInput = undefined;
    a.setOperatorAnswers(parseAnswers([`${q.id}=decline`]));
    assert.match((await run(a))!, /not approved/);
    assert.equal(pending(a), undefined);
    assert.equal(a.objective.verification.length, 0);
  });

  test("with an operator: the prompt carries the origin, a refusal skips the run and records no question, an approval runs it", async () => {
    const calls: any[] = [];
    const refuse = withLedger(makeAgent());
    const refused = await refuse.runRequirementVerifier(REQ, "true");
    assert.ok(refused);
    refuse.activeTurn = { onConfirm: async (tool: string, args: any) => { calls.push({ tool, args }); return false; } };
    const noRun = await run(refuse);
    assert.equal(noRun, "R1: verifier execution was not approved", "no 'no operator' suffix when an operator declined");
    assert.equal(calls[0].tool, "verifier");
    assert.equal(calls[0].args.command, "true");
    assert.match(calls[0].args.detail, /model-declared verifier for R1/);
    assert.equal(refuse.objective.verification.length, 0);

    const approver = withLedger(makeAgent());
    approver.activeTurn = { onConfirm: async () => true };
    assert.equal(await run(approver), undefined);
    assert.equal(approver.objective.verification.at(-1).status, "PASSED");
    assert.equal(pending(approver), undefined, "an operator's answer is not a recorded question");
  });
});
