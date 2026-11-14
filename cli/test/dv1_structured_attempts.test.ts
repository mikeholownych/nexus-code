/**
 * DV-1: a verifier attempt keeps exit code, failing test names and a redacted, capped excerpt; an environmental
 * failure (tool missing, exit 126/127, sandbox) is classified apart from a candidate failure and is never reused.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AutonomousAgent } from "../src/agent.js";
import { DEFAULT_CONTINUATION, HarnessConfig } from "../src/types.js";
import { startGateway, makeRepo, Reply } from "./helpers/fixtures.js";
import {
  attemptEvidence,
  createLedger,
  describeAttemptEvidence,
  MAX_ATTEMPT_EXCERPT_BYTES,
  priorAttempt,
  recordAttempt,
  renderPinnedLedger,
} from "../src/core/objective.js";
import { buildSessionExport } from "../src/session_export.js";

const quiet = (agent: AutonomousAgent) => {
  (agent as any).ui = new Proxy({}, { get: () => () => {} });
  return agent;
};
const cfg = (endpoint: string, workspace: string): HarnessConfig => ({
  endpoint,
  model: "m",
  maxSteps: 30,
  temperature: 0,
  workspace,
  shell: "bash",
  approvalMode: "auto",
  fullAccess: true,
  continuation: { ...DEFAULT_CONTINUATION },
});
const done: Reply = { kind: "tools", calls: [{ name: "task_completed", args: { summary: "done" } }] };
const same = { inputs: "abc", epoch: "e", mutationSeq: 1, external: "x" };

describe("DV-1 classification", () => {
  test("exit 127 is ENVIRONMENT: not a candidate failure and never a pass", () => {
    const ev = attemptEvidence("sh: 1: nosuchtool: not found", 127);
    assert.equal(ev.classification, "ENVIRONMENT");
    assert.equal(ev.exitCode, 127);
    assert.equal(attemptEvidence("anything", 126).classification, "ENVIRONMENT");
    for (const out of ["bash: nosuchtool: command not found", "Error: spawn pytest ENOENT", "bwrap: sandbox error: cannot mount"]) {
      assert.equal(attemptEvidence(out, 1).classification, "ENVIRONMENT", out);
    }
    const ledger = createLedger("obj");
    recordAttempt(ledger, { command: "make test", ...same, status: "FAILED", ...attemptEvidence("make: nosuchtool: command not found", 127) });
    assert.equal(ledger.verification[0].status, "FAILED", "an environmental failure is never a pass");
    assert.equal(priorAttempt(ledger, "make test", same), undefined, "a rerun after the environment is fixed must run");
  });

  test("a real test failure records exit code, failing test names and a redacted excerpt", () => {
    const out = "not ok 1 - adds numbers\n✖ subtracts numbers (1.2ms)\nAPI_KEY=supersecretvalue123\nuse ghp_abcdefghijklmnopqrstuvwxyz0123456789\n";
    const ev = attemptEvidence(out, 1);
    assert.equal(ev.classification, "CANDIDATE_FAILED");
    assert.equal(ev.exitCode, 1);
    assert.deepEqual(ev.failingTests, ["adds numbers", "subtracts numbers"]);
    assert.doesNotMatch(ev.excerpt!, /supersecretvalue123|ghp_abcdefghij/);
    assert.match(ev.excerpt!, /REDACTED/);
    assert.match(describeAttemptEvidence(ev), /exit 1.*adds numbers; subtracts numbers/);
    assert.doesNotMatch(describeAttemptEvidence(ev), /REDACTED|API_KEY/);
    const ledger = createLedger("obj");
    recordAttempt(ledger, { command: "make test", ...same, status: "FAILED", ...ev });
    assert.equal(priorAttempt(ledger, "make test", same)?.status, "FAILED", "a candidate failure on unchanged inputs is still reused");
  });

  test("a failing test whose output mentions a missing command stays a candidate failure", () => {
    assert.equal(attemptEvidence("not ok 1 - runs tool\nbash: x: command not found", 1).classification, "CANDIDATE_FAILED");
  });

  test("the excerpt is capped in bytes and keeps the tail", () => {
    const ev = attemptEvidence(`${"é".repeat(5000)}\nTAIL-MARKER`, 1);
    assert.ok(Buffer.byteLength(ev.excerpt!) <= MAX_ATTEMPT_EXCERPT_BYTES);
    assert.match(ev.excerpt!, /TAIL-MARKER$/);
  });
});

describe("DV-1 persistence", () => {
  test("a pre-DV-1 attempt loads unchanged and renders without structured fields", () => {
    const ledger = createLedger("obj");
    ledger.verification.push({ n: 1, command: "make test", ...same, status: "FAILED", failedCheck: "FAIL x", at: "t" });
    const reloaded = JSON.parse(JSON.stringify(ledger));
    assert.equal(priorAttempt(reloaded, "make test", same)?.failedCheck, "FAIL x");
    assert.equal(reloaded.verification[0].classification, undefined);
    assert.match(renderPinnedLedger(reloaded), /#1 make test -> FAILED on abc \(FAIL x\)$/m);
  });

  test("a restored attempt keeps its structured fields and the model sees classification, exit code and names", async () => {
    const ledger = createLedger("obj");
    recordAttempt(ledger, { command: "make test", ...same, status: "FAILED", ...attemptEvidence("not ok 1 - adds numbers\n", 1) });
    const gw = await startGateway(() => ({ kind: "text", content: "ok" }));
    const repo = makeRepo();
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      agent.restoreSession([{ role: "system", content: "s" }], false, JSON.parse(JSON.stringify(ledger)));
      const a = agent.getObjective()!.verification[0];
      assert.equal(a.exitCode, 1);
      assert.deepEqual(a.failingTests, ["adds numbers"]);
      assert.equal(a.classification, "CANDIDATE_FAILED");
      assert.match(a.excerpt!, /not ok 1/);
      assert.match(renderPinnedLedger(agent.getObjective()!), /CANDIDATE_FAILED, exit 1, failing tests: adds numbers/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the session export carries the structured fields", () => {
    const ledger = createLedger("obj");
    recordAttempt(ledger, { command: "make test", ...same, status: "FAILED", ...attemptEvidence("not ok 1 - adds numbers\n", 1) });
    const manager = { readArchivedHistory: () => ({ messages: [], unreadableLines: 0 }) } as any;
    const { json } = buildSessionExport(manager, { id: "s", messages: [], objective: ledger } as any);
    const attempt = (json.export as any).taskState.verificationAttempts[0];
    assert.equal(attempt.exitCode, 1);
    assert.deepEqual(attempt.failingTests, ["adds numbers"]);
  });
});

describe("DV-1 at the agent layer", () => {
  test("an ENVIRONMENT failure is not skipped on unchanged inputs and the model sees the classification", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\tnosuchtool-dv1\n" });
    const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "c.txt", content: "c\n" } }] } : n <= 3 ? done : { kind: "text", content: "done" }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Make the build pass.");
      const attempts = agent.getObjective()!.verification;
      assert.ok(attempts.length >= 2);
      assert.ok(attempts.every((a) => a.status === "FAILED" && a.classification === "ENVIRONMENT"), JSON.stringify(attempts));
      const msg = (gw.requests[2] as any).messages.filter((m: any) => m.role === "tool" && m.name === "task_completed").at(-1);
      assert.match(msg.content, /Evidence: ENVIRONMENT/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a failing test records exit code, test names and a redacted excerpt", { timeout: 60_000 }, async () => {
    const repo = makeRepo({ Makefile: "test:\n\t@echo 'not ok 1 - adds numbers'\n\t@echo 'token=hunter2hunter2'\n\t@echo 'ℹ tests 1'\n\t@exit 1\n" });
    const gw = await startGateway((n) => (n === 1 ? { kind: "tools", calls: [{ name: "write_file", args: { path: "c.txt", content: "c\n" } }] } : n === 2 ? done : { kind: "text", content: "done" }));
    const agent = quiet(new AutonomousAgent(cfg(gw.url, repo)));
    try {
      await agent.runTurn("Make the build pass.");
      const failed = agent.getObjective()!.verification.filter((a) => a.status === "FAILED");
      assert.ok(failed.length >= 1);
      const a = failed.at(-1)!;
      assert.equal(a.classification, "CANDIDATE_FAILED");
      assert.notEqual(a.exitCode, undefined);
      assert.deepEqual(a.failingTests, ["adds numbers"]);
      assert.doesNotMatch(a.excerpt!, /hunter2hunter2/);
    } finally {
      agent.shutdown();
      await gw.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
